import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type ActingOrganization,
  AppError,
  badRequest,
  conflict,
  DocumentsClient,
  emitEvent,
  notFound,
  type PaginationQueryDto,
  requireRole,
  skipTake,
  toPage,
} from '@uboce/common';

import { SERVICE_NAME } from '../config.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { Decision, Severity, SubjectType } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma.service.js';
import { validateResults } from './decision.js';

type Tx = Prisma.TransactionClient;

export const INSPECTOR_ROLES = ['owner', 'admin', 'quality_inspector'];
const READ_ROLES = [...INSPECTOR_ROLES, 'warehouse_operator', 'procurement_officer', 'manufacturer', 'farmer', 'auditor'];
const include = { lines: true, nonconformances: true } as const;

export interface ResultsInput {
  decision: Decision;
  notes?: string;
  criteria?: Record<string, string>;
  evidenceDocumentIds?: string[];
  lines: { itemId: string; acceptedQuantity: string; rejectedQuantity: string; notes?: string }[];
  nonconformances?: { description: string; severity: Severity }[];
}

@Injectable()
export class QualityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documents: DocumentsClient,
  ) {}

  /** Called for receipts that need inspection; idempotent per subject. */
  async openForReceipt(tx: Tx, organizationId: string, receiptId: string, lines: { itemId: string; quantity: Prisma.Decimal }[]) {
    const merged = new Map<string, Prisma.Decimal>();
    for (const l of lines) merged.set(l.itemId, l.quantity.plus(merged.get(l.itemId) ?? 0));
    await tx.inspection.upsert({
      where: { subjectType_subjectId: { subjectType: 'receipt', subjectId: receiptId } },
      update: {},
      create: {
        organizationId,
        subjectType: 'receipt',
        subjectId: receiptId,
        lines: { create: [...merged].filter(([, q]) => q.greaterThan(0)).map(([itemId, q]) => ({ itemId, inspectedQuantity: q })) },
      },
    });
  }

  /** Inspections of lots, batches or products, requested directly. */
  async open(org: ActingOrganization, subjectType: SubjectType, subjectId: string, lines: { itemId: string; quantity: string }[], criteria?: Record<string, string>) {
    requireRole(org, INSPECTOR_ROLES, 'request inspections');
    if (subjectType === 'receipt') throw badRequest('receipt_subject', 'Receipt inspections are opened automatically when goods arrive');
    const existing = await this.prisma.inspection.findUnique({ where: { subjectType_subjectId: { subjectType, subjectId } } });
    if (existing) throw conflict('already_inspected', 'This subject already has an inspection');
    return this.prisma.inspection.create({
      data: {
        organizationId: org.organization.id,
        subjectType,
        subjectId,
        criteria,
        lines: { create: lines.map((l) => ({ itemId: l.itemId, inspectedQuantity: l.quantity })) },
      },
      include,
    });
  }

  async list(org: ActingOrganization, status: 'pending' | 'completed' | undefined, query: PaginationQueryDto) {
    requireRole(org, READ_ROLES, 'view inspections');
    const where = { organizationId: org.organization.id, ...(status ? { status } : {}) };
    const [items, total] = await Promise.all([
      this.prisma.inspection.findMany({ where, include, orderBy: { createdAt: 'desc' }, ...skipTake(query) }),
      this.prisma.inspection.count({ where }),
    ]);
    return toPage(items, total, query);
  }

  async get(org: ActingOrganization, id: string) {
    requireRole(org, READ_ROLES, 'view inspections');
    return this.owned(org, id);
  }

  /** Records the decision once; downstream services act on the InspectionCompleted event. */
  async record(org: ActingOrganization, userId: string, id: string, input: ResultsInput) {
    requireRole(org, INSPECTOR_ROLES, 'record inspection results');
    const inspection = await this.owned(org, id);
    if (inspection.status === 'completed') throw conflict('already_completed', 'Results were already recorded');

    const byItem = new Map(inspection.lines.map((l) => [l.itemId, l]));
    if (input.lines.length !== byItem.size || input.lines.some((l) => !byItem.has(l.itemId))) {
      throw badRequest('lines_mismatch', 'Give results for exactly the inspected items');
    }
    const problem = validateResults(
      input.decision,
      input.lines.map((l) => ({ ...l, inspectedQuantity: byItem.get(l.itemId)!.inspectedQuantity })),
    );
    if (problem) throw new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'invalid_results', problem);

    // Evidence must be this organization's own, uploaded documents.
    for (const documentId of input.evidenceDocumentIds ?? []) {
      const doc = await this.documents.get(documentId);
      if (!doc || doc.ownerOrganizationId !== org.organization.id || doc.status !== 'available') {
        throw badRequest('invalid_evidence', `Document ${documentId} is not an available document of your organization`);
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.inspection.updateMany({
        where: { id, status: 'pending' },
        data: {
          status: 'completed',
          decision: input.decision,
          notes: input.notes,
          criteria: input.criteria,
          evidenceDocumentIds: input.evidenceDocumentIds ?? [],
          inspectorUserId: userId,
          completedAt: new Date(),
        },
      });
      if (count === 0) throw conflict('already_completed', 'Results were already recorded');
      for (const l of input.lines) {
        await tx.inspectionLine.update({
          where: { inspectionId_itemId: { inspectionId: id, itemId: l.itemId } },
          data: { acceptedQuantity: l.acceptedQuantity, rejectedQuantity: l.rejectedQuantity, notes: l.notes },
        });
      }
      if (input.nonconformances?.length) {
        await tx.nonconformance.createMany({
          data: input.nonconformances.map((n) => ({ ...n, inspectionId: id, organizationId: org.organization.id })),
        });
      }
      await emitEvent(tx, SERVICE_NAME, 'InspectionCompleted', id, {
        inspectionId: id,
        organizationId: org.organization.id,
        subjectType: inspection.subjectType,
        subjectId: inspection.subjectId,
        decision: input.decision,
        lines: input.lines.map((l) => ({ itemId: l.itemId, acceptedQuantity: l.acceptedQuantity, rejectedQuantity: l.rejectedQuantity })),
      });
      return tx.inspection.findUniqueOrThrow({ where: { id }, include });
    });
  }

  async closeNonconformance(org: ActingOrganization, userId: string, id: string, correctiveAction: string) {
    requireRole(org, INSPECTOR_ROLES, 'close nonconformances');
    const { count } = await this.prisma.nonconformance.updateMany({
      where: { id, organizationId: org.organization.id, status: 'open' },
      data: { status: 'closed', correctiveAction, closedByUserId: userId, closedAt: new Date() },
    });
    if (count === 0) throw notFound('Open nonconformance');
    return this.prisma.nonconformance.findUniqueOrThrow({ where: { id } });
  }

  private async owned(org: ActingOrganization, id: string) {
    const inspection = await this.prisma.inspection.findFirst({ where: { id, organizationId: org.organization.id }, include });
    if (!inspection) throw notFound('Inspection');
    return inspection;
  }
}
