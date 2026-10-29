import { Injectable } from '@nestjs/common';
import { type ActingOrganization, badRequest, locationScope, requireRole } from '@uboce/common';

import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma.service.js';

const REPORT_ROLES = ['owner', 'admin', 'sales_representative', 'finance_officer', 'auditor'];
const { Decimal } = Prisma;

export interface LocationReport {
  from: string;
  to: string;
  locations: {
    branchId: string | null;
    orders: number;
    fulfilled: number;
    cancelled: number;
    uncollected: number;
    deliveryFailed: number;
    returns: number;
    sales: Record<string, string>;
    averageOrderValue: Record<string, string>;
    discounts: Record<string, string>;
    topProducts: { sku: string | null; description: string; quantity: string; value: string; currency: string }[];
  }[];
}

/** Store / location performance from the orders themselves (PRD addendum 2.11: location-level reports). */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async forOrganization(org: ActingOrganization, from?: string, to?: string) {
    requireRole(org, REPORT_ROLES, 'view sales reports');
    return this.build(org.organization.id, locationScope(org), from, to);
  }

  /** Same report for internal callers (Analytics AI summaries). */
  build(organizationId: string, scope: string[] | null, fromIso?: string, toIso?: string): Promise<LocationReport> {
    const to = toIso ? new Date(`${toIso.slice(0, 10)}T23:59:59.999Z`) : new Date();
    const from = fromIso ? new Date(`${fromIso.slice(0, 10)}T00:00:00Z`) : new Date(to.getTime() - 30 * 86_400_000);
    if (from > to) throw badRequest('invalid_range', '`from` must not be after `to`');
    return this.run(organizationId, scope, from, to);
  }

  private async run(organizationId: string, scope: string[] | null, from: Date, to: Date): Promise<LocationReport> {
    const where: Prisma.OrderWhereInput = {
      supplierOrganizationId: organizationId,
      createdAt: { gte: from, lte: to },
      ...(scope ? { fulfillmentBranchId: { in: scope } } : {}),
    };
    const [byStatus, totals, returns, lines] = await Promise.all([
      this.prisma.order.groupBy({ by: ['fulfillmentBranchId', 'status'], where, _count: true }),
      this.prisma.order.groupBy({
        by: ['fulfillmentBranchId', 'currency'],
        where: { ...where, status: { notIn: ['cancelled', 'pending_confirmation'] } },
        _sum: { total: true, discountTotal: true },
        _count: true,
      }),
      this.prisma.returnRequest.findMany({ where: { order: where }, select: { order: { select: { fulfillmentBranchId: true } } } }),
      this.prisma.orderLine.groupBy({
        by: ['sku', 'description'],
        where: { order: { ...where, status: { notIn: ['cancelled', 'pending_confirmation'] } } },
        _sum: { quantity: true, lineTotal: true },
        orderBy: { _sum: { lineTotal: 'desc' } },
        take: 200,
      }),
    ]);

    const keys = new Set<string | null>([...byStatus.map((r) => r.fulfillmentBranchId), ...totals.map((r) => r.fulfillmentBranchId)]);
    // Top products need the location too: one cheap pass over the top lines' orders.
    const lineRows = lines.length
      ? await this.prisma.orderLine.findMany({
          where: { order: { ...where, status: { notIn: ['cancelled', 'pending_confirmation'] } } },
          select: { sku: true, description: true, quantity: true, lineTotal: true, order: { select: { fulfillmentBranchId: true, currency: true } } },
          take: 5000,
        })
      : [];

    const locations = [...keys].map((branchId) => {
      const status = (s: string) => byStatus.filter((r) => r.fulfillmentBranchId === branchId && r.status === s).reduce((n, r) => n + r._count, 0);
      const mine = totals.filter((r) => r.fulfillmentBranchId === branchId);
      const sales: Record<string, string> = {};
      const average: Record<string, string> = {};
      const discounts: Record<string, string> = {};
      for (const t of mine) {
        const sum = t._sum.total ?? new Decimal(0);
        sales[t.currency] = sum.toFixed(2);
        average[t.currency] = t._count ? sum.dividedBy(t._count).toFixed(2) : '0.00';
        discounts[t.currency] = (t._sum.discountTotal ?? new Decimal(0)).toFixed(2);
      }
      const products = new Map<string, { sku: string | null; description: string; quantity: Prisma.Decimal; value: Prisma.Decimal; currency: string }>();
      for (const l of lineRows.filter((x) => x.order.fulfillmentBranchId === branchId)) {
        const key = `${l.sku ?? l.description}|${l.order.currency}`;
        const p = products.get(key) ?? { sku: l.sku, description: l.description, quantity: new Decimal(0), value: new Decimal(0), currency: l.order.currency };
        p.quantity = p.quantity.plus(l.quantity);
        p.value = p.value.plus(l.lineTotal);
        products.set(key, p);
      }
      return {
        branchId,
        orders: byStatus.filter((r) => r.fulfillmentBranchId === branchId).reduce((n, r) => n + r._count, 0),
        fulfilled: status('fulfilled') + status('closed'),
        cancelled: status('cancelled'),
        uncollected: status('uncollected'),
        deliveryFailed: status('delivery_failed'),
        returns: returns.filter((r) => r.order.fulfillmentBranchId === branchId).length,
        sales,
        averageOrderValue: average,
        discounts,
        topProducts: [...products.values()]
          .sort((a, b) => b.value.comparedTo(a.value))
          .slice(0, 5)
          .map((p) => ({ sku: p.sku, description: p.description, quantity: p.quantity.toString(), value: p.value.toFixed(2), currency: p.currency })),
      };
    });
    locations.sort((a, b) => b.orders - a.orders);
    return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10), locations };
  }
}
