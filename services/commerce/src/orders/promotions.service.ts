import { Injectable } from '@nestjs/common';
import {
  type ActingOrganization,
  badRequest,
  conflict,
  notFound,
  type PaginationQueryDto,
  requirePermission,
  requireRole,
  skipTake,
  toPage,
} from '@uboce/common';

import { Prisma } from '../generated/prisma/client.js';
import type { Promotion } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma.service.js';
import type { CouponCheckDto, OffersQueryDto, PromotionDto } from './orders.dto.js';
import { discountFor } from './state-machine.js';

type Tx = Prisma.TransactionClient;
const { Decimal } = Prisma;

const SELLER_ROLES = ['owner', 'admin', 'sales_representative'];

export interface AppliedPromotion {
  promotion: Promotion;
  discount: Prisma.Decimal;
}

/** Supplier promotions and coupons (PRD addendum 2.4). The best applicable one is applied per order. */
@Injectable()
export class PromotionsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(org: ActingOrganization, query: PaginationQueryDto) {
    requireRole(org, [...SELLER_ROLES, 'finance_officer', 'auditor'], 'view promotions');
    const where = { organizationId: org.organization.id };
    const [items, total] = await Promise.all([
      this.prisma.promotion.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(query) }),
      this.prisma.promotion.count({ where }),
    ]);
    return toPage(items, total, query);
  }

  async create(org: ActingOrganization, dto: PromotionDto) {
    requireRole(org, SELLER_ROLES, 'manage promotions');
    requirePermission(org, 'promotions:manage', 'manage promotions');
    try {
      return await this.prisma.promotion.create({
        data: { ...this.data(dto), organizationId: org.organization.id },
      });
    } catch (error) {
      throw this.codeTaken(error);
    }
  }

  async update(org: ActingOrganization, promotionId: string, dto: PromotionDto) {
    requireRole(org, SELLER_ROLES, 'manage promotions');
    const existing = await this.prisma.promotion.findFirst({
      where: { id: promotionId, organizationId: org.organization.id },
    });
    if (!existing) throw notFound('Promotion');
    try {
      return await this.prisma.promotion.update({ where: { id: promotionId }, data: this.data(dto) });
    } catch (error) {
      throw this.codeTaken(error);
    }
  }

  /** Buyers: current advertised offers (automatic discounts and public coupon codes). */
  async offers(query: OffersQueryDto) {
    const now = new Date();
    const where: Prisma.PromotionWhereInput = {
      active: true,
      advertised: true,
      ...(query.supplierOrganizationId ? { organizationId: query.supplierOrganizationId } : {}),
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
      ],
    };
    const [rows, total] = await Promise.all([
      this.prisma.promotion.findMany({
        where,
        orderBy: [{ endsAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
        ...skipTake(query),
      }),
      this.prisma.promotion.count({ where }),
    ]);
    const items = rows
      .filter((p) => p.usageLimit === null || p.usedCount < p.usageLimit)
      .map((p) => ({
        id: p.id,
        supplierOrganizationId: p.organizationId,
        name: p.name,
        description: p.description,
        code: p.code,
        automatic: p.code === null,
        kind: p.kind,
        value: p.value.toString(),
        currency: p.currency,
        minSubtotal: p.minSubtotal?.toString() ?? null,
        maxDiscount: p.maxDiscount?.toString() ?? null,
        endsAt: p.endsAt,
      }));
    return toPage(items, total, query);
  }

  /** Buyers: what promotions saved them, newest first. */
  async savings(org: ActingOrganization, query: PaginationQueryDto) {
    const where = { buyerOrganizationId: org.organization.id };
    const [rows, total, sums] = await Promise.all([
      this.prisma.promotionRedemption.findMany({
        where,
        include: { promotion: true },
        orderBy: { createdAt: 'desc' },
        ...skipTake(query),
      }),
      this.prisma.promotionRedemption.count({ where }),
      this.prisma.promotionRedemption.findMany({
        where,
        select: { amount: true, promotion: { select: { currency: true } } },
      }),
    ]);
    const totals: Record<string, string> = {};
    for (const s of sums)
      totals[s.promotion.currency] = new Decimal(totals[s.promotion.currency] ?? 0).plus(s.amount).toFixed(2);
    return {
      ...toPage(
        rows.map((r) => ({
          id: r.id,
          orderId: r.orderId,
          amount: r.amount.toFixed(2),
          currency: r.promotion.currency,
          promotionName: r.promotion.name,
          code: r.promotion.code,
          supplierOrganizationId: r.promotion.organizationId,
          createdAt: r.createdAt,
        })),
        total,
        query,
      ),
      totals,
    };
  }

  /** Sellers: how each promotion performed (uses and discount given). */
  async performance(org: ActingOrganization) {
    requireRole(org, [...SELLER_ROLES, 'finance_officer', 'auditor'], 'view promotions');
    const rows = await this.prisma.promotionRedemption.groupBy({
      by: ['promotionId'],
      where: { promotion: { organizationId: org.organization.id } },
      _count: { _all: true },
      _sum: { amount: true },
    });
    const buyers = await this.prisma.promotionRedemption.groupBy({
      by: ['promotionId', 'buyerOrganizationId'],
      where: { promotion: { organizationId: org.organization.id } },
    });
    return rows.map((r) => ({
      promotionId: r.promotionId,
      orders: r._count._all,
      buyers: buyers.filter((b) => b.promotionId === r.promotionId).length,
      discountGiven: (r._sum.amount ?? new Decimal(0)).toFixed(2),
    }));
  }

  /** What a buyer would save: lets the checkout show the discount before ordering. */
  async check(org: ActingOrganization, dto: CouponCheckDto) {
    const applied = await this.best(
      this.prisma,
      dto.supplierOrganizationId,
      org.organization.id,
      dto.currency,
      new Decimal(dto.subtotal),
      dto.couponCode,
    );
    return applied
      ? {
          promotionId: applied.promotion.id,
          name: applied.promotion.name,
          code: applied.promotion.code,
          discount: applied.discount.toString(),
        }
      : { promotionId: null, name: null, code: null, discount: '0' };
  }

  /**
   * The best promotion for an order: the coupon (if given; an invalid coupon is an error)
   * or the largest automatic one. Limits are checked inside the order's transaction.
   */
  async best(
    tx: Tx | PrismaService,
    supplierId: string,
    buyerId: string,
    currency: string,
    subtotal: Prisma.Decimal,
    couponCode?: string | null,
  ): Promise<AppliedPromotion | null> {
    const now = new Date();
    const window = {
      organizationId: supplierId,
      active: true,
      currency,
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
      ],
    };
    const candidates = await tx.promotion.findMany({
      where: { ...window, OR: [{ code: null }, ...(couponCode ? [{ code: couponCode.toUpperCase() }] : [])] },
    });
    if (couponCode && !candidates.some((p) => p.code === couponCode.toUpperCase()))
      throw badRequest('invalid_coupon', 'This coupon is not valid for this supplier');

    let best: AppliedPromotion | null = null;
    for (const p of candidates) {
      if (p.minSubtotal && subtotal.lt(p.minSubtotal)) {
        if (p.code)
          throw badRequest(
            'coupon_minimum',
            `This coupon needs an order of at least ${p.minSubtotal.toString()} ${currency}`,
          );
        continue;
      }
      if (p.usageLimit !== null && p.usedCount >= p.usageLimit) {
        if (p.code) throw badRequest('coupon_used_up', 'This coupon has been used up');
        continue;
      }
      if (p.perBuyerLimit !== null) {
        const mine = await tx.promotionRedemption.count({
          where: { promotionId: p.id, buyerOrganizationId: buyerId },
        });
        if (mine >= p.perBuyerLimit) {
          if (p.code) throw badRequest('coupon_used_up', 'You have already used this coupon');
          continue;
        }
      }
      const discount = new Decimal(
        discountFor(
          { kind: p.kind, value: p.value.toNumber(), maxDiscount: p.maxDiscount?.toNumber() ?? null },
          subtotal.toNumber(),
        ),
      );
      // A coupon the buyer typed always wins over automatic offers.
      if (p.code || !best || (!best.promotion.code && discount.gt(best.discount)))
        best = { promotion: p, discount };
    }
    return best && best.discount.gt(0) ? best : null;
  }

  /** Records the use; the conditional increment stops a limited coupon being over-used concurrently. */
  async redeem(tx: Tx, applied: AppliedPromotion, orderId: string, buyerId: string) {
    const { promotion } = applied;
    const { count } = await tx.promotion.updateMany({
      where: {
        id: promotion.id,
        ...(promotion.usageLimit !== null ? { usedCount: { lt: promotion.usageLimit } } : {}),
      },
      data: { usedCount: { increment: 1 } },
    });
    if (count === 0) throw conflict('coupon_used_up', 'This coupon has just been used up');
    await tx.promotionRedemption.create({
      data: { promotionId: promotion.id, orderId, buyerOrganizationId: buyerId, amount: applied.discount },
    });
  }

  private data(dto: PromotionDto) {
    if (dto.kind === 'percent' && Number(dto.value) > 100)
      throw badRequest('invalid_value', 'A percentage cannot exceed 100');
    const startsAt = dto.startsAt ? new Date(dto.startsAt) : null;
    const endsAt = dto.endsAt ? new Date(dto.endsAt) : null;
    if (startsAt && endsAt && startsAt > endsAt)
      throw badRequest('invalid_dates', 'The promotion must end after it starts');
    return {
      name: dto.name.trim(),
      code: dto.code ? dto.code.toUpperCase() : null,
      kind: dto.kind,
      value: dto.value,
      currency: dto.currency,
      minSubtotal: dto.minSubtotal ?? null,
      maxDiscount: dto.maxDiscount ?? null,
      startsAt,
      endsAt,
      usageLimit: dto.usageLimit ?? null,
      perBuyerLimit: dto.perBuyerLimit ?? null,
      active: dto.active ?? true,
      description: dto.description?.trim() || null,
      advertised: dto.advertised ?? true,
    };
  }

  private codeTaken(error: unknown) {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
      ? conflict('code_taken', 'Another promotion already uses this code')
      : error;
  }
}
