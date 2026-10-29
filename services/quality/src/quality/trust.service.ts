import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import {
  type ActingOrganization,
  badRequest,
  CommerceClient,
  conflict,
  emitEvent,
  forbidden,
  notFound,
  type PaginationQueryDto,
  qualified,
  requireRole,
  skipTake,
  toPage,
} from '@uboce/common';

import { SERVICE_NAME } from '../config.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma.service.js';
import { INSPECTOR_ROLES } from './quality.service.js';
import { needsModeration, scorecardScore, SCORE_FORMULA_VERSION } from './trust-rules.js';

type Tx = Prisma.TransactionClient;

const BUYER_ROLES = ['owner', 'admin', 'procurement_officer', 'quality_inspector'];
const SELLER_ROLES = ['owner', 'admin', 'sales_representative', 'quality_inspector'];
const SPEC_ROLES = [...INSPECTOR_ROLES, 'sales_representative', 'manufacturer', 'farmer'];
const DELIVERED = ['fulfilled', 'closed', 'partially_fulfilled'];

export interface SpecInput {
  productId: string;
  name: string;
  parameters: { name: string; target?: string; min?: string; max?: string; unit?: string; method?: string }[];
}

export interface CertificationInput {
  productId?: string | null;
  kind: string;
  certificateNumber: string;
  issuer: string;
  issuedAt: string;
  expiresAt?: string | null;
  documentId?: string | null;
}

/**
 * Trust signals beyond inspections (PRD addendum 2.5): product specifications,
 * certifications, buyer quality claims, verified reviews and monthly scorecards.
 */
@Injectable()
export class TrustService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TrustService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly commerce: CommerceClient,
  ) {}

  onApplicationBootstrap() {
    // Keep the current month's scorecards fresh; past months are frozen once the month ends.
    const run = () => this.snapshotAll().catch((e) => this.logger.warn(`Scorecard refresh failed: ${(e as Error).message}`));
    this.timer = setInterval(run, 6 * 3_600_000);
    this.timer.unref();
    setTimeout(run, 30_000).unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // ---- Specifications ------------------------------------------------------------------

  async publishSpec(org: ActingOrganization, userId: string, input: SpecInput) {
    requireRole(org, SPEC_ROLES, 'manage quality specifications');
    if (!input.parameters.length) throw badRequest('no_parameters', 'Add at least one parameter');
    return this.prisma.$transaction(async (tx) => {
      const last = await tx.qualitySpec.findFirst({ where: { productId: input.productId }, orderBy: { version: 'desc' } });
      if (last && last.organizationId !== org.organization.id) throw forbidden('This product belongs to another organization');
      await tx.qualitySpec.updateMany({ where: { productId: input.productId, active: true }, data: { active: false } });
      return tx.qualitySpec.create({
        data: {
          organizationId: org.organization.id,
          productId: input.productId,
          version: (last?.version ?? 0) + 1,
          name: input.name.trim(),
          parameters: input.parameters,
          createdByUserId: userId,
        },
      });
    });
  }

  /** Public: the current spec and valid certifications for a product (shown on its page). */
  async productQuality(productId: string) {
    const now = new Date();
    const [spec, certifications] = await Promise.all([
      this.prisma.qualitySpec.findFirst({ where: { productId, active: true }, orderBy: { version: 'desc' } }),
      this.prisma.certification.findMany({ where: { productId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } }),
    ]);
    return { spec, certifications };
  }

  listSpecs(org: ActingOrganization) {
    return this.prisma.qualitySpec.findMany({ where: { organizationId: org.organization.id }, orderBy: [{ productId: 'asc' }, { version: 'desc' }] });
  }

  // ---- Certifications -----------------------------------------------------------------------

  async addCertification(org: ActingOrganization, input: CertificationInput) {
    requireRole(org, SPEC_ROLES, 'manage certifications');
    const issuedAt = new Date(input.issuedAt);
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiresAt && expiresAt <= issuedAt) throw badRequest('invalid_dates', 'A certificate must expire after it was issued');
    return this.prisma.certification.create({
      data: {
        organizationId: org.organization.id,
        productId: input.productId ?? null,
        kind: input.kind,
        certificateNumber: input.certificateNumber.trim(),
        issuer: input.issuer.trim(),
        issuedAt,
        expiresAt,
        documentId: input.documentId ?? null,
      },
    });
  }

  async revokeCertification(org: ActingOrganization, id: string) {
    requireRole(org, SPEC_ROLES, 'manage certifications');
    const cert = await this.prisma.certification.findFirst({ where: { id, organizationId: org.organization.id } });
    if (!cert) throw notFound('Certification');
    return this.prisma.certification.update({ where: { id }, data: { revokedAt: cert.revokedAt ?? new Date() } });
  }

  /** Public list for an organization's profile, with expiry state. */
  async certifications(organizationId: string) {
    const rows = await this.prisma.certification.findMany({ where: { organizationId }, orderBy: { issuedAt: 'desc' } });
    const now = new Date();
    return rows.map((c) => ({ ...c, state: c.revokedAt ? 'revoked' : c.expiresAt && c.expiresAt <= now ? 'expired' : 'valid' }));
  }

  // ---- Quality claims -------------------------------------------------------------------------

  async openClaim(
    org: ActingOrganization,
    userId: string,
    input: { orderId: string; orderLineId?: string; reason: string; description: string; affectedQuantity?: string; evidenceDocumentIds?: string[] },
  ) {
    requireRole(org, BUYER_ROLES, 'open quality claims');
    const order = await this.commerce.getOrder(input.orderId);
    if (!order || order.buyerOrganizationId !== org.organization.id) throw notFound('Order');
    if (!DELIVERED.includes(order.status)) throw conflict('not_delivered', 'Claims can be opened once goods are delivered');
    const line = input.orderLineId ? order.lines.find((l) => l.id === input.orderLineId) : null;
    if (input.orderLineId && !line) throw badRequest('unknown_line', 'That line is not on the order');
    if (line && input.affectedQuantity && Number(input.affectedQuantity) > Number(line.fulfilledQuantity)) {
      throw badRequest('over_quantity', `At most ${line.fulfilledQuantity} was delivered on that line`);
    }

    return this.prisma.$transaction(async (tx) => {
      const claim = await tx.qualityClaim.create({
        data: {
          number: await this.nextNumber(tx, 'QC'),
          orderId: order.id,
          orderLineId: input.orderLineId ?? null,
          orderNumber: order.number,
          buyerOrganizationId: order.buyerOrganizationId,
          supplierOrganizationId: order.supplierOrganizationId,
          reason: input.reason,
          description: input.description.trim(),
          affectedQuantity: input.affectedQuantity ?? null,
          evidenceDocumentIds: input.evidenceDocumentIds ?? [],
          openedByUserId: userId,
        },
      });
      await emitEvent(tx, SERVICE_NAME, 'QualityClaimOpened', claim.id, {
        claimId: claim.id,
        orderId: claim.orderId,
        buyerOrganizationId: claim.buyerOrganizationId,
        supplierOrganizationId: claim.supplierOrganizationId,
        reason: claim.reason,
      });
      return claim;
    });
  }

  async listClaims(org: ActingOrganization, side: 'buyer' | 'supplier', query: PaginationQueryDto & { status?: string }) {
    const where: Prisma.QualityClaimWhereInput = {
      [side === 'buyer' ? 'buyerOrganizationId' : 'supplierOrganizationId']: org.organization.id,
      ...(query.status ? { status: query.status as Prisma.QualityClaimWhereInput['status'] } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.qualityClaim.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(query) }),
      this.prisma.qualityClaim.count({ where }),
    ]);
    return toPage(items, total, query);
  }

  async getClaim(org: ActingOrganization, id: string) {
    const claim = await this.prisma.qualityClaim.findFirst({
      where: { id, OR: [{ buyerOrganizationId: org.organization.id }, { supplierOrganizationId: org.organization.id }] },
    });
    if (!claim) throw notFound('Claim');
    return claim;
  }

  /** The supplier accepts (with a remedy) or rejects (with reasons). */
  async respondToClaim(org: ActingOrganization, userId: string, id: string, input: { decision: 'accept' | 'reject'; resolution?: string; response: string }) {
    requireRole(org, SELLER_ROLES, 'respond to claims');
    const claim = await this.prisma.qualityClaim.findFirst({ where: { id, supplierOrganizationId: org.organization.id } });
    if (!claim) throw notFound('Claim');
    if (claim.status !== 'open') throw conflict('invalid_transition', `A ${claim.status} claim cannot be answered`);
    if (input.decision === 'accept' && !input.resolution) throw badRequest('resolution_required', 'Say how you will make it right');
    return this.prisma.qualityClaim.update({
      where: { id },
      data: {
        status: input.decision === 'accept' ? 'accepted' : 'rejected',
        resolution: input.decision === 'accept' ? input.resolution : 'none',
        supplierResponse: input.response.trim(),
        respondedByUserId: userId,
        respondedAt: new Date(),
      },
    });
  }

  /** The buyer closes the claim (remedy received) or escalates a rejection to a dispute. */
  async buyerClaimAction(org: ActingOrganization, id: string, action: 'resolve' | 'escalate') {
    requireRole(org, BUYER_ROLES, 'manage claims');
    const claim = await this.prisma.qualityClaim.findFirst({ where: { id, buyerOrganizationId: org.organization.id } });
    if (!claim) throw notFound('Claim');
    if (action === 'resolve' && !['accepted', 'open', 'rejected', 'escalated'].includes(claim.status)) throw conflict('invalid_transition', `A ${claim.status} claim cannot be resolved`);
    if (action === 'escalate' && claim.status !== 'rejected') throw conflict('invalid_transition', 'Only rejected claims can be escalated; open a dispute on the order');
    return this.prisma.qualityClaim.update({
      where: { id },
      data: action === 'resolve' ? { status: 'resolved', resolvedAt: new Date() } : { status: 'escalated' },
    });
  }

  // ---- Reviews -------------------------------------------------------------------------------

  /** Verified: the reviewer's organization bought (and received) this order from the supplier. */
  async review(org: ActingOrganization, userId: string, input: { orderId: string; productId?: string; rating: number; title?: string; body?: string }) {
    requireRole(org, BUYER_ROLES, 'write reviews');
    const order = await this.commerce.getOrder(input.orderId);
    if (!order || order.buyerOrganizationId !== org.organization.id) throw notFound('Order');
    if (!DELIVERED.includes(order.status)) throw conflict('not_delivered', 'You can review once the order is delivered');
    if (input.productId && !order.lines.some((l) => l.productId === input.productId)) throw badRequest('not_on_order', 'That product is not on the order');
    const held = needsModeration(`${input.title ?? ''} ${input.body ?? ''}`);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const review = await tx.review.create({
          data: {
            orderId: order.id,
            reviewerOrganizationId: org.organization.id,
            reviewerUserId: userId,
            subjectOrganizationId: order.supplierOrganizationId,
            productId: input.productId ?? null,
            subjectKey: input.productId ?? 'business',
            rating: input.rating,
            title: input.title?.trim() || null,
            body: input.body?.trim() || null,
            status: held ? 'pending' : 'published',
          },
        });
        if (!held) await this.announceReview(tx, review);
        return review;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw conflict('already_reviewed', 'You already reviewed this for this order');
      throw error;
    }
  }

  /** Public: published reviews of an organization or a product. */
  async publicReviews(filter: { organizationId?: string; productId?: string }, query: PaginationQueryDto) {
    if (!filter.organizationId && !filter.productId) throw badRequest('filter_required', 'Pass organizationId or productId');
    const where: Prisma.ReviewWhereInput = {
      status: 'published',
      ...(filter.organizationId ? { subjectOrganizationId: filter.organizationId } : {}),
      ...(filter.productId ? { productId: filter.productId } : { productId: null }),
    };
    const [items, total, stats] = await Promise.all([
      this.prisma.review.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        select: { id: true, rating: true, title: true, body: true, productId: true, supplierReply: true, repliedAt: true, createdAt: true, reviewerOrganizationId: true },
        ...skipTake(query),
      }),
      this.prisma.review.count({ where }),
      this.prisma.review.groupBy({ by: ['rating'], where, _count: true }),
    ]);
    return { ...toPage(items, total, query), summary: summarize(stats) };
  }

  /** Rating summaries for many organizations at once (directory and search cards). */
  async ratings(organizationIds: string[]) {
    const rows = await this.prisma.review.groupBy({
      by: ['subjectOrganizationId'],
      where: { subjectOrganizationId: { in: organizationIds }, status: 'published', productId: null },
      _avg: { rating: true },
      _count: true,
    });
    return rows.map((r) => ({ organizationId: r.subjectOrganizationId, average: r._avg.rating ? Number(r._avg.rating.toFixed(2)) : null, count: r._count }));
  }

  /** Reviews written about my organization (all statuses I may see), to reply to. */
  async receivedReviews(org: ActingOrganization, query: PaginationQueryDto) {
    const where: Prisma.ReviewWhereInput = { subjectOrganizationId: org.organization.id, status: { in: ['published', 'pending'] } };
    const [items, total] = await Promise.all([
      this.prisma.review.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(query) }),
      this.prisma.review.count({ where }),
    ]);
    return toPage(items, total, query);
  }

  async reply(org: ActingOrganization, id: string, reply: string) {
    requireRole(org, SELLER_ROLES, 'reply to reviews');
    const review = await this.prisma.review.findFirst({ where: { id, subjectOrganizationId: org.organization.id } });
    if (!review) throw notFound('Review');
    return this.prisma.review.update({ where: { id }, data: { supplierReply: reply.trim(), repliedAt: new Date() } });
  }

  /** Platform moderation queue. */
  async moderationQueue(query: PaginationQueryDto) {
    const where: Prisma.ReviewWhereInput = { status: 'pending' };
    const [items, total] = await Promise.all([
      this.prisma.review.findMany({ where, orderBy: { createdAt: 'asc' }, ...skipTake(query) }),
      this.prisma.review.count({ where }),
    ]);
    return toPage(items, total, query);
  }

  async moderate(userId: string, id: string, decision: 'publish' | 'hide' | 'reject', note?: string) {
    const review = await this.prisma.review.findUnique({ where: { id } });
    if (!review) throw notFound('Review');
    const status = decision === 'publish' ? 'published' : decision === 'hide' ? 'hidden' : 'rejected';
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.review.update({ where: { id }, data: { status, moderationNote: note ?? null, moderatedByUserId: userId } });
      if (status === 'published' && review.status !== 'published') await this.announceReview(tx, updated);
      return updated;
    });
  }

  private announceReview(tx: Tx, r: { id: string; orderId: string; subjectOrganizationId: string; productId: string | null; rating: number }) {
    return emitEvent(tx, SERVICE_NAME, 'ReviewPublished', r.id, {
      reviewId: r.id,
      orderId: r.orderId,
      subjectOrganizationId: r.subjectOrganizationId,
      productId: r.productId,
      rating: r.rating,
    });
  }

  // ---- Scorecards ------------------------------------------------------------------------------

  async scorecards(organizationId: string) {
    return this.prisma.scorecardSnapshot.findMany({ where: { organizationId }, orderBy: { period: 'desc' }, take: 24 });
  }

  /** Recomputes the current month for every organization with quality activity. */
  async snapshotAll(now = new Date()) {
    const period = now.toISOString().slice(0, 7);
    const start = new Date(`${period}-01T00:00:00Z`);
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    const range = { gte: start, lt: end };
    const [inspections, claims, reviews] = await Promise.all([
      this.prisma.inspection.groupBy({ by: ['organizationId', 'decision'], where: { status: 'completed', completedAt: range }, _count: true }),
      this.prisma.qualityClaim.groupBy({ by: ['supplierOrganizationId', 'status'], where: { createdAt: range }, _count: true }),
      this.prisma.review.groupBy({ by: ['subjectOrganizationId'], where: { status: 'published', createdAt: range }, _avg: { rating: true }, _count: true }),
    ]);
    const orgs = new Set([...inspections.map((i) => i.organizationId), ...claims.map((c) => c.supplierOrganizationId), ...reviews.map((r) => r.subjectOrganizationId)]);
    for (const organizationId of orgs) {
      const mine = inspections.filter((i) => i.organizationId === organizationId);
      const total = mine.reduce((s, i) => s + i._count, 0);
      const passed = mine.filter((i) => i.decision !== 'rejected').reduce((s, i) => s + i._count, 0);
      const myClaims = claims.filter((c) => c.supplierOrganizationId === organizationId);
      const opened = myClaims.reduce((s, c) => s + c._count, 0);
      const accepted = myClaims.filter((c) => c.status === 'accepted' || c.status === 'resolved').reduce((s, c) => s + c._count, 0);
      const r = reviews.find((x) => x.subjectOrganizationId === organizationId);
      const nonconformances = await this.prisma.nonconformance.count({ where: { createdAt: range, inspection: { organizationId } } });
      const data = {
        inspections: total,
        inspectionsPassed: passed,
        nonconformances,
        claimsOpened: opened,
        claimsAccepted: accepted,
        reviewCount: r?._count ?? 0,
        averageRating: r?._avg.rating ?? null,
        score: scorecardScore({ inspections: total, passed, claims: opened, averageRating: r?._avg.rating ?? null }),
        formulaVersion: SCORE_FORMULA_VERSION,
        computedAt: new Date(),
      };
      await this.prisma.scorecardSnapshot.upsert({ where: { organizationId_period: { organizationId, period } }, update: data, create: { organizationId, period, ...data } });
    }
    return { period, organizations: orgs.size };
  }

  private async nextNumber(tx: Tx, prefix: string) {
    const year = new Date().getUTCFullYear();
    const key = `${prefix}-${year}`;
    const [row] = await tx.$queryRaw<{ last: number }[]>`
      INSERT INTO ${Prisma.raw(qualified('claim_counters'))} (key, last) VALUES (${key}, 1)
      ON CONFLICT (key) DO UPDATE SET last = claim_counters.last + 1 RETURNING last`;
    return `${key}-${String(row!.last).padStart(6, '0')}`;
  }
}

function summarize(stats: { rating: number; _count: number }[]) {
  const count = stats.reduce((s, r) => s + r._count, 0);
  const average = count ? stats.reduce((s, r) => s + r.rating * r._count, 0) / count : null;
  const distribution = Object.fromEntries([1, 2, 3, 4, 5].map((n) => [n, stats.find((r) => r.rating === n)?._count ?? 0]));
  return { count, average: average === null ? null : Math.round(average * 100) / 100, distribution };
}
