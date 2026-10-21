import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type ActingOrganization,
  AppError,
  badRequest,
  buildEvent,
  conflict,
  notFound,
  OrganizationsClient,
  requireRole,
  skipTake,
  toOutboxRow,
  toPage,
} from '@uboce/common';
import type { EventCatalog, EventType } from '@uboce/contracts';

import { env, SERVICE_NAME } from './config.js';
import { Prisma } from './generated/prisma/client.js';
import { PrismaService } from './prisma.service.js';
import type { CreateRfqDto, ListRfqsQueryDto, SubmitQuotationDto } from './procurement.dto.js';
import { BUYER_ROLES, priceQuotation, quotingBlocker, READ_ROLES, type RfqForEligibility, SUPPLIER_ROLES } from './rules.js';

type Tx = Prisma.TransactionClient;

const rfqInclude = { lines: { orderBy: { lineNumber: 'asc' } }, invitations: true } as const;
type RfqWithLines = Prisma.RfqGetPayload<{ include: typeof rfqInclude }>;
const quotationInclude = { lines: true } as const;

const eligibility = (rfq: RfqWithLines): RfqForEligibility => ({
  buyerOrganizationId: rfq.buyerOrganizationId,
  status: rfq.status,
  visibility: rfq.visibility,
  responseDeadline: rfq.responseDeadline,
  invitedSupplierIds: rfq.invitations.map((i) => i.supplierOrganizationId),
});

const BLOCKER_MESSAGES: Record<string, string> = {
  not_invited: 'Your organization is not invited to this RFQ',
  rfq_not_open: 'This RFQ is not accepting quotations',
  deadline_passed: 'The response deadline has passed',
};

@Injectable()
export class ProcurementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationsClient,
  ) {}

  // ---- Buyer: RFQs ------------------------------------------------------------

  async createRfq(org: ActingOrganization, userId: string, dto: CreateRfqDto) {
    requireRole(org, BUYER_ROLES, 'create RFQs');
    const buyerId = org.organization.id;
    const visibility = dto.visibility ?? 'invited';
    const invited = [...new Set(dto.invitedSupplierOrganizationIds ?? [])];
    if (visibility === 'invited' && invited.length === 0) {
      throw badRequest('suppliers_required', 'Invite at least one supplier, or make the RFQ open');
    }
    if (invited.includes(buyerId)) throw badRequest('self_invited', 'You cannot invite your own organization');
    if (new Date(dto.responseDeadline) <= new Date()) throw badRequest('deadline_in_past', 'The response deadline must be in the future');

    // Cross-organization relationships must be explicit and valid (PRD 3.2).
    const suppliers = await Promise.all(invited.map((id) => this.organizations.getOrganization(id)));
    const unknown = invited.filter((_, i) => !suppliers[i] || suppliers[i]!.status !== 'active');
    if (unknown.length) throw badRequest('unknown_suppliers', 'Some invited suppliers do not exist or are inactive', unknown);

    return this.prisma.rfq.create({
      data: {
        buyerOrganizationId: buyerId,
        title: dto.title.trim(),
        description: dto.description?.trim() || null,
        currency: dto.currency,
        deliveryTerms: dto.deliveryTerms?.trim() || null,
        deliveryLocation: dto.deliveryLocation?.trim() || null,
        responseDeadline: new Date(dto.responseDeadline),
        visibility,
        createdByUserId: userId,
        lines: {
          create: dto.lines.map((l, i) => ({
            lineNumber: i + 1,
            productId: l.productId,
            description: l.description.trim(),
            quantity: l.quantity,
            unitOfMeasure: l.unitOfMeasure,
            specifications: l.specifications,
          })),
        },
        invitations: { create: invited.map((supplierOrganizationId) => ({ supplierOrganizationId })) },
      },
      include: rfqInclude,
    });
  }

  async publishRfq(org: ActingOrganization, rfqId: string) {
    requireRole(org, BUYER_ROLES, 'publish RFQs');
    const rfq = await this.ownRfq(org, rfqId);
    if (rfq.status !== 'draft') throw conflict('invalid_transition', `Cannot publish an RFQ that is ${rfq.status}`);
    if (rfq.responseDeadline <= new Date()) throw badRequest('deadline_in_past', 'Move the deadline into the future first');

    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.rfq.updateMany({ where: { id: rfqId, status: 'draft' }, data: { status: 'published', publishedAt: new Date() } });
      if (count === 0) throw conflict('concurrent_change', 'The RFQ changed; reload and try again');
      await this.emit(tx, 'RFQPublished', rfq.id, {
        rfqId: rfq.id,
        buyerOrganizationId: rfq.buyerOrganizationId,
        title: rfq.title,
        responseDeadline: rfq.responseDeadline.toISOString(),
        invitedSupplierOrganizationIds: rfq.invitations.map((i) => i.supplierOrganizationId),
        lineCount: rfq.lines.length,
      });
      return tx.rfq.findUniqueOrThrow({ where: { id: rfqId }, include: rfqInclude });
    });
  }

  async cancelRfq(org: ActingOrganization, rfqId: string) {
    requireRole(org, BUYER_ROLES, 'cancel RFQs');
    const rfq = await this.ownRfq(org, rfqId);
    if (rfq.status !== 'draft' && rfq.status !== 'published') {
      throw conflict('invalid_transition', `Cannot cancel an RFQ that is ${rfq.status}`);
    }
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.rfq.updateMany({ where: { id: rfqId, status: rfq.status }, data: { status: 'cancelled' } });
      if (count === 0) throw conflict('concurrent_change', 'The RFQ changed; reload and try again');
      await tx.quotation.updateMany({ where: { rfqId, status: 'submitted' }, data: { status: 'rejected' } });
      return tx.rfq.findUniqueOrThrow({ where: { id: rfqId }, include: rfqInclude });
    });
  }

  async listBuyerRfqs(org: ActingOrganization, query: ListRfqsQueryDto) {
    requireRole(org, READ_ROLES, 'view RFQs');
    const where: Prisma.RfqWhereInput = { buyerOrganizationId: org.organization.id, ...(query.status ? { status: query.status } : {}) };
    const [items, total] = await Promise.all([
      this.prisma.rfq.findMany({
        where,
        include: { _count: { select: { lines: true, quotations: { where: { status: { not: 'withdrawn' } } } } } },
        orderBy: { createdAt: 'desc' },
        ...skipTake(query),
      }),
      this.prisma.rfq.count({ where }),
    ]);
    return toPage(items, total, query);
  }

  /** Published RFQs this supplier may quote on: open ones and those it's invited to. */
  async listOpenRfqs(org: ActingOrganization, query: ListRfqsQueryDto) {
    requireRole(org, READ_ROLES, 'view RFQs');
    const supplierId = org.organization.id;
    const where: Prisma.RfqWhereInput = {
      status: 'published',
      responseDeadline: { gt: new Date() },
      buyerOrganizationId: { not: supplierId },
      OR: [{ visibility: 'open' }, { invitations: { some: { supplierOrganizationId: supplierId } } }],
    };
    const [items, total] = await Promise.all([
      this.prisma.rfq.findMany({
        where,
        include: { lines: { orderBy: { lineNumber: 'asc' } }, quotations: { where: { supplierOrganizationId: supplierId }, select: { id: true, status: true, revision: true } } },
        orderBy: { responseDeadline: 'asc' },
        ...skipTake(query),
      }),
      this.prisma.rfq.count({ where }),
    ]);
    return toPage(
      items.map(({ quotations, ...rfq }) => ({ ...rfq, myQuotation: quotations[0] ?? null })),
      total,
      query,
    );
  }

  /** Buyers see everything on their own RFQ; a supplier sees the RFQ and only its own quotation. */
  async getRfq(org: ActingOrganization, rfqId: string) {
    requireRole(org, READ_ROLES, 'view RFQs');
    const rfq = await this.prisma.rfq.findUnique({ where: { id: rfqId }, include: rfqInclude });
    if (!rfq) throw notFound('RFQ');
    const me = org.organization.id;
    if (rfq.buyerOrganizationId === me) return { ...rfq, role: 'buyer' as const };
    if (quotingBlocker(eligibility(rfq), me) === 'not_invited') throw notFound('RFQ');
    const myQuotation = await this.prisma.quotation.findUnique({
      where: { rfqId_supplierOrganizationId: { rfqId, supplierOrganizationId: me } },
      include: quotationInclude,
    });
    // Suppliers never see who else was invited.
    const { invitations: _, ...visible } = rfq;
    return { ...visible, role: 'supplier' as const, myQuotation };
  }

  /** Side-by-side comparison for the buyer, cheapest first. */
  async compareQuotations(org: ActingOrganization, rfqId: string) {
    requireRole(org, BUYER_ROLES, 'compare quotations');
    await this.ownRfq(org, rfqId);
    const quotations = await this.prisma.quotation.findMany({
      where: { rfqId, status: { in: ['submitted', 'accepted', 'rejected'] } },
      include: quotationInclude,
      orderBy: [{ total: 'asc' }, { updatedAt: 'asc' }],
    });
    const now = new Date();
    return quotations.map((q) => ({ ...q, expired: q.validUntil <= now }));
  }

  // ---- Supplier: quotations -------------------------------------------------

  /** Submits a quotation, or revises this supplier's existing one (history is kept). */
  async submitQuotation(org: ActingOrganization, userId: string, rfqId: string, dto: SubmitQuotationDto) {
    requireRole(org, SUPPLIER_ROLES, 'submit quotations');
    const supplierId = org.organization.id;
    const rfq = await this.prisma.rfq.findUnique({ where: { id: rfqId }, include: rfqInclude });
    if (!rfq) throw notFound('RFQ');
    const blocker = quotingBlocker(eligibility(rfq), supplierId);
    if (blocker === 'not_invited') throw notFound('RFQ');
    if (blocker) throw new AppError(HttpStatus.CONFLICT, blocker, BLOCKER_MESSAGES[blocker]!);
    if (env.REQUIRE_VERIFIED_SUPPLIERS && org.organization.verificationStatus !== 'verified') {
      throw new AppError(HttpStatus.FORBIDDEN, 'verification_required', 'Complete business verification before quoting');
    }
    if (new Date(dto.validUntil) <= new Date()) throw badRequest('validity_in_past', 'validUntil must be in the future');

    let priced: ReturnType<typeof priceQuotation>;
    try {
      priced = priceQuotation(rfq.lines, dto.lines);
    } catch (error) {
      throw badRequest('invalid_lines', (error as Error).message);
    }

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.quotation.findUnique({
        where: { rfqId_supplierOrganizationId: { rfqId, supplierOrganizationId: supplierId } },
        include: quotationInclude,
      });
      if (existing && (existing.status === 'accepted' || existing.status === 'rejected')) {
        throw conflict('quotation_closed', `This quotation was already ${existing.status}`);
      }

      const fields = {
        currency: rfq.currency,
        total: priced.total,
        validUntil: new Date(dto.validUntil),
        notes: dto.notes?.trim() || null,
        submittedByUserId: userId,
        status: 'submitted' as const,
      };
      const lines = priced.lines.map((l) => ({ ...l }));

      let quotation;
      if (existing) {
        await tx.quotationRevision.create({
          data: { quotationId: existing.id, revision: existing.revision, snapshot: JSON.parse(JSON.stringify(existing)) },
        });
        await tx.quotationLine.deleteMany({ where: { quotationId: existing.id } });
        quotation = await tx.quotation.update({
          where: { id: existing.id },
          data: { ...fields, revision: { increment: 1 }, lines: { create: lines } },
          include: quotationInclude,
        });
      } else {
        quotation = await tx.quotation.create({
          data: { ...fields, rfqId, supplierOrganizationId: supplierId, lines: { create: lines } },
          include: quotationInclude,
        });
      }

      await this.emit(tx, 'QuotationSubmitted', quotation.id, {
        quotationId: quotation.id,
        rfqId,
        buyerOrganizationId: rfq.buyerOrganizationId,
        supplierOrganizationId: supplierId,
        revision: quotation.revision,
        total: quotation.total.toFixed(2),
        currency: quotation.currency,
      });
      return quotation;
    });
  }

  async listMyQuotations(org: ActingOrganization, query: ListRfqsQueryDto) {
    requireRole(org, READ_ROLES, 'view quotations');
    const where = { supplierOrganizationId: org.organization.id };
    const [items, total] = await Promise.all([
      this.prisma.quotation.findMany({
        where,
        include: { rfq: { select: { id: true, title: true, status: true, responseDeadline: true, currency: true } } },
        orderBy: { updatedAt: 'desc' },
        ...skipTake(query),
      }),
      this.prisma.quotation.count({ where }),
    ]);
    return toPage(items, total, query);
  }

  async getMyQuotation(org: ActingOrganization, quotationId: string) {
    requireRole(org, READ_ROLES, 'view quotations');
    const quotation = await this.prisma.quotation.findFirst({
      where: { id: quotationId, supplierOrganizationId: org.organization.id },
      include: { ...quotationInclude, revisions: { orderBy: { revision: 'asc' } } },
    });
    if (!quotation) throw notFound('Quotation');
    return quotation;
  }

  async withdrawQuotation(org: ActingOrganization, quotationId: string) {
    requireRole(org, SUPPLIER_ROLES, 'withdraw quotations');
    const { count } = await this.prisma.quotation.updateMany({
      where: { id: quotationId, supplierOrganizationId: org.organization.id, status: 'submitted' },
      data: { status: 'withdrawn' },
    });
    if (count === 0) throw conflict('invalid_transition', 'Only a submitted quotation of yours can be withdrawn');
    return this.getMyQuotation(org, quotationId);
  }

  // ---- Buyer: award -----------------------------------------------------------

  /**
   * Accepts one quotation and closes the RFQ. The conditional update makes
   * this safe against double-clicks and concurrent accepts: exactly one wins,
   * so exactly one QuotationAccepted event — and one order — results (PRD 6.2).
   */
  async acceptQuotation(org: ActingOrganization, userId: string, rfqId: string, quotationId: string) {
    requireRole(org, BUYER_ROLES, 'accept quotations');
    const rfq = await this.ownRfq(org, rfqId);
    const quotation = await this.prisma.quotation.findFirst({ where: { id: quotationId, rfqId }, include: quotationInclude });
    if (!quotation) throw notFound('Quotation');
    if (rfq.status === 'awarded') throw conflict('already_awarded', 'This RFQ has already been awarded');
    if (rfq.status !== 'published') throw conflict('invalid_transition', `Cannot award an RFQ that is ${rfq.status}`);
    if (quotation.status !== 'submitted') throw conflict('quotation_not_acceptable', `This quotation is ${quotation.status}`);
    if (quotation.validUntil <= new Date()) throw conflict('quotation_expired', 'This quotation has expired');

    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.rfq.updateMany({
        where: { id: rfqId, status: 'published', awardedQuotationId: null },
        data: { status: 'awarded', awardedQuotationId: quotationId },
      });
      if (count === 0) throw conflict('already_awarded', 'This RFQ has already been awarded');
      const accepted = await tx.quotation.update({ where: { id: quotationId }, data: { status: 'accepted' }, include: quotationInclude });
      await tx.quotation.updateMany({ where: { rfqId, id: { not: quotationId }, status: 'submitted' }, data: { status: 'rejected' } });

      const rfqLines = new Map(rfq.lines.map((l) => [l.id, l]));
      await this.emit(tx, 'QuotationAccepted', quotationId, {
        quotationId,
        quotationRevision: accepted.revision,
        rfqId,
        rfqTitle: rfq.title,
        buyerOrganizationId: rfq.buyerOrganizationId,
        supplierOrganizationId: accepted.supplierOrganizationId,
        acceptedByUserId: userId,
        currency: accepted.currency,
        deliveryTerms: rfq.deliveryTerms,
        deliveryLocation: rfq.deliveryLocation,
        total: accepted.total.toFixed(4),
        lines: accepted.lines
          .map((l) => ({ l, r: rfqLines.get(l.rfqLineId)! }))
          .sort((a, b) => a.r.lineNumber - b.r.lineNumber)
          .map(({ l, r }) => ({
            rfqLineId: l.rfqLineId,
            productId: r.productId,
            description: r.description,
            quantity: l.quantity.toFixed(4),
            unitOfMeasure: r.unitOfMeasure,
            unitPrice: l.unitPrice.toFixed(4),
            lineTotal: l.lineTotal.toFixed(4),
            leadTimeDays: l.leadTimeDays,
          })),
      });
      return { rfqId, quotation: accepted };
    });
  }

  private async ownRfq(org: ActingOrganization, rfqId: string) {
    const rfq = await this.prisma.rfq.findFirst({ where: { id: rfqId, buyerOrganizationId: org.organization.id }, include: rfqInclude });
    if (!rfq) throw notFound('RFQ');
    return rfq;
  }

  private emit<T extends EventType>(tx: Tx, type: T, aggregateId: string, data: EventCatalog[T]) {
    return tx.outboxEvent.create({ data: toOutboxRow(buildEvent(SERVICE_NAME, type, aggregateId, data)) });
  }
}
