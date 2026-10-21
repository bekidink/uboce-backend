import { Injectable } from '@nestjs/common';
import {
  type ActingOrganization,
  badRequest,
  CommerceClient,
  conflict,
  DocumentsClient,
  emitEvent,
  forbidden,
  notFound,
  type PaginationQueryDto,
  requireRole,
  skipTake,
  toPage,
} from '@uboce/common';

import { SERVICE_NAME } from '../config.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { DisputeStatus, Outcome, SubjectType } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma.service.js';

type Tx = Prisma.TransactionClient;
const PARTY_ROLES = ['owner', 'admin', 'procurement_officer', 'sales_representative', 'finance_officer', 'logistics_operator', 'quality_inspector'];
const APPEAL_WINDOW_DAYS = 14;
const include = { statements: { orderBy: { createdAt: 'asc' } } } as const;

@Injectable()
export class DisputesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commerce: CommerceClient,
    private readonly documents: DocumentsClient,
  ) {}

  /** Either party to an order opens a dispute against the other (PRD 6.6). */
  async open(
    org: ActingOrganization,
    userId: string,
    dto: { subjectType: SubjectType; subjectId: string; orderId: string; category: string; description: string; evidenceDocumentIds?: string[] },
  ) {
    requireRole(org, PARTY_ROLES, 'open disputes');
    const me = org.organization.id;
    const order = await this.commerce.getOrder(dto.orderId);
    if (!order || (order.buyerOrganizationId !== me && order.supplierOrganizationId !== me)) throw notFound('Order');
    if (dto.subjectType === 'order' && dto.subjectId !== dto.orderId) throw badRequest('subject_mismatch', 'For an order dispute, subjectId is the order ID');
    const against = order.buyerOrganizationId === me ? order.supplierOrganizationId : order.buyerOrganizationId;

    const duplicate = await this.prisma.dispute.findFirst({
      where: { subjectType: dto.subjectType, subjectId: dto.subjectId, openedByOrganizationId: me, status: { in: ['open', 'under_review'] } },
    });
    if (duplicate) throw conflict('dispute_open', 'You already have an open dispute about this');
    await this.checkEvidence(org, dto.evidenceDocumentIds ?? []);

    const dispute = await this.prisma.$transaction(async (tx) => {
      const created = await tx.dispute.create({
        data: {
          subjectType: dto.subjectType,
          subjectId: dto.subjectId,
          orderId: dto.orderId,
          openedByOrganizationId: me,
          againstOrganizationId: against,
          category: dto.category,
          description: dto.description,
          openedByUserId: userId,
          statements: { create: { organizationId: me, authorUserId: userId, role: 'opener', text: dto.description, evidenceDocumentIds: dto.evidenceDocumentIds ?? [] } },
        },
        include,
      });
      await this.announceOpened(tx, created);
      return created;
    });
    await this.shareEvidence(dispute.id, against, dto.evidenceDocumentIds ?? []);
    return dispute;
  }

  async addStatement(org: ActingOrganization, userId: string, disputeId: string, text: string, evidenceDocumentIds: string[] = []) {
    requireRole(org, PARTY_ROLES, 'respond to disputes');
    const dispute = await this.asParty(org, disputeId);
    if (dispute.status !== 'open' && dispute.status !== 'under_review') throw conflict('dispute_closed', `This dispute is ${dispute.status}`);
    await this.checkEvidence(org, evidenceDocumentIds);
    const role = dispute.openedByOrganizationId === org.organization.id ? 'opener' : 'respondent';
    await this.prisma.disputeStatement.create({ data: { disputeId, organizationId: org.organization.id, authorUserId: userId, role, text, evidenceDocumentIds } });
    const other = role === 'opener' ? dispute.againstOrganizationId : dispute.openedByOrganizationId;
    await this.shareEvidence(disputeId, other, evidenceDocumentIds);
    return this.asParty(org, disputeId);
  }

  async withdraw(org: ActingOrganization, disputeId: string) {
    requireRole(org, PARTY_ROLES, 'withdraw disputes');
    const dispute = await this.asParty(org, disputeId);
    if (dispute.openedByOrganizationId !== org.organization.id) throw forbidden('Only the organization that opened it can withdraw');
    const { count } = await this.prisma.dispute.updateMany({ where: { id: disputeId, status: { in: ['open', 'under_review'] } }, data: { status: 'withdrawn', resolvedAt: new Date() } });
    if (count === 0) throw conflict('dispute_closed', `This dispute is ${dispute.status}`);
    await this.prisma.$transaction((tx) => this.announceResolved(tx, dispute, 'withdrawn'));
    return this.asParty(org, disputeId);
  }

  /** One appeal per decision, by either party, within the appeal window. */
  async appeal(org: ActingOrganization, userId: string, disputeId: string, reason: string) {
    requireRole(org, PARTY_ROLES, 'appeal disputes');
    const original = await this.asParty(org, disputeId);
    if (original.status !== 'resolved' || !original.resolvedAt) throw conflict('not_resolved', 'Only resolved disputes can be appealed');
    if (Date.now() - original.resolvedAt.getTime() > APPEAL_WINDOW_DAYS * 86_400_000) throw conflict('appeal_window_closed', `Appeals are possible for ${APPEAL_WINDOW_DAYS} days`);
    if (await this.prisma.dispute.findUnique({ where: { appealOfDisputeId: disputeId } })) throw conflict('already_appealed', 'This decision was already appealed');

    const me = org.organization.id;
    return this.prisma.$transaction(async (tx) => {
      const appeal = await tx.dispute.create({
        data: {
          subjectType: original.subjectType,
          subjectId: original.subjectId,
          orderId: original.orderId,
          openedByOrganizationId: me,
          againstOrganizationId: me === original.openedByOrganizationId ? original.againstOrganizationId : original.openedByOrganizationId,
          category: original.category,
          description: `Appeal: ${reason}`,
          appealOfDisputeId: original.id,
          openedByUserId: userId,
          statements: { create: { organizationId: me, authorUserId: userId, role: 'opener', text: reason } },
        },
        include,
      });
      await this.announceOpened(tx, appeal);
      return appeal;
    });
  }

  async listForParty(org: ActingOrganization, status: DisputeStatus | undefined, query: PaginationQueryDto) {
    requireRole(org, PARTY_ROLES.concat('auditor'), 'view disputes');
    const me = org.organization.id;
    const where: Prisma.DisputeWhereInput = { OR: [{ openedByOrganizationId: me }, { againstOrganizationId: me }], ...(status ? { status } : {}) };
    const [items, total] = await Promise.all([
      this.prisma.dispute.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(query) }),
      this.prisma.dispute.count({ where }),
    ]);
    return toPage(items, total, query);
  }

  get(org: ActingOrganization, disputeId: string) {
    requireRole(org, PARTY_ROLES.concat('auditor'), 'view disputes');
    return this.asParty(org, disputeId);
  }

  // ---- Reviewers ----------------------------------------------------------------------

  async queue(status: DisputeStatus, query: PaginationQueryDto) {
    const where = { status };
    const [items, total] = await Promise.all([
      this.prisma.dispute.findMany({ where, include, orderBy: { createdAt: 'asc' }, ...skipTake(query) }),
      this.prisma.dispute.count({ where }),
    ]);
    return toPage(items, total, query);
  }

  async reviewerGet(disputeId: string) {
    const dispute = await this.prisma.dispute.findUnique({ where: { id: disputeId }, include });
    if (!dispute) throw notFound('Dispute');
    return dispute;
  }

  async claim(reviewerId: string, disputeId: string) {
    const { count } = await this.prisma.dispute.updateMany({ where: { id: disputeId, status: 'open' }, data: { status: 'under_review', reviewerUserId: reviewerId } });
    if (count === 0) throw conflict('not_open', 'Only open disputes can be claimed');
    return this.reviewerGet(disputeId);
  }

  async reviewerStatement(reviewerId: string, disputeId: string, text: string) {
    await this.reviewerGet(disputeId);
    await this.prisma.disputeStatement.create({ data: { disputeId, authorUserId: reviewerId, role: 'reviewer', text, evidenceDocumentIds: [] } });
    return this.reviewerGet(disputeId);
  }

  /** A reasoned decision. Any correction happens in the owning service, not here (PRD 6.6). */
  async resolve(reviewerId: string, disputeId: string, outcome: Outcome, summary: string, followUpActions?: string) {
    const dispute = await this.reviewerGet(disputeId);
    if (dispute.status !== 'under_review') throw conflict('not_under_review', 'Claim the dispute before resolving it');
    if (dispute.reviewerUserId !== reviewerId) throw forbidden('Another reviewer has this dispute');
    return this.prisma.$transaction(async (tx) => {
      const resolved = await tx.dispute.update({
        where: { id: disputeId },
        data: { status: 'resolved', outcome, resolutionSummary: summary, followUpActions, resolvedAt: new Date() },
        include,
      });
      await this.announceResolved(tx, resolved, outcome);
      return resolved;
    });
  }

  // ---- Internals -------------------------------------------------------------------

  /** Only the two organizations in the case can see it (PRD 5.18: access by case membership). */
  private async asParty(org: ActingOrganization, disputeId: string) {
    const me = org.organization.id;
    const dispute = await this.prisma.dispute.findFirst({ where: { id: disputeId, OR: [{ openedByOrganizationId: me }, { againstOrganizationId: me }] }, include });
    if (!dispute) throw notFound('Dispute');
    return dispute;
  }

  private async checkEvidence(org: ActingOrganization, ids: string[]) {
    for (const id of ids) {
      const doc = await this.documents.get(id);
      if (!doc || doc.ownerOrganizationId !== org.organization.id || doc.status !== 'available') {
        throw badRequest('invalid_evidence', `Document ${id} is not an available document of your organization`);
      }
    }
  }

  /** The other party and dispute reviewers may read the evidence. */
  private async shareEvidence(disputeId: string, otherOrganizationId: string, ids: string[]) {
    for (const id of ids) {
      await this.documents.grant(id, { type: 'case', id: `dispute:${disputeId}` }, 'Dispute evidence');
      await this.documents.grant(id, { type: 'organization', id: otherOrganizationId }, 'Dispute evidence for the other party');
    }
  }

  private announceOpened(tx: Tx, d: { id: string; subjectType: string; subjectId: string; orderId: string; openedByOrganizationId: string; againstOrganizationId: string; category: string }) {
    return emitEvent(tx, SERVICE_NAME, 'DisputeOpened', d.id, {
      disputeId: d.id,
      subjectType: d.subjectType,
      subjectId: d.subjectId,
      orderId: d.orderId,
      openedByOrganizationId: d.openedByOrganizationId,
      againstOrganizationId: d.againstOrganizationId,
      category: d.category,
    });
  }

  private announceResolved(tx: Tx, d: { id: string; subjectType: string; subjectId: string; openedByOrganizationId: string; againstOrganizationId: string }, outcome: string) {
    return emitEvent(tx, SERVICE_NAME, 'DisputeResolved', d.id, {
      disputeId: d.id,
      subjectType: d.subjectType,
      subjectId: d.subjectId,
      openedByOrganizationId: d.openedByOrganizationId,
      againstOrganizationId: d.againstOrganizationId,
      outcome,
    });
  }
}
