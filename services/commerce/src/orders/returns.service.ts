import { Injectable } from '@nestjs/common';
import { type ActingOrganization, badRequest, conflict, notFound, qualified, requireRole, skipTake, toPage } from '@uboce/common';

import { Prisma } from '../generated/prisma/client.js';
import type { ReturnRequest } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma.service.js';
import type { CreateReturnDto, ListReturnsQueryDto, ReturnDecisionDto } from './orders.dto.js';
import { BUYER_ROLES, OrdersService, READ_ROLES, SUPPLIER_ROLES } from './orders.service.js';
import { type OrderParty, type PolicySnapshot, withinReturnWindow } from './state-machine.js';

type Tx = Prisma.TransactionClient;
const { Decimal } = Prisma;

type Line = { orderLineId: string; quantity: string };

/**
 * Returns (PRD addendum 2.6): the buyer asks within the policy's return window;
 * the supplier approves or rejects, then confirms receipt. A received return tells
 * Finance what is owed back (after the restocking fee), and Finance handles the refund.
 */
@Injectable()
export class ReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
  ) {}

  async request(org: ActingOrganization, userId: string, orderId: string, dto: CreateReturnDto) {
    requireRole(org, BUYER_ROLES, 'request returns');
    const order = await this.orders.owned(org, 'buyer', orderId);
    if (!['fulfilled', 'closed', 'partially_fulfilled'].includes(order.status)) throw conflict('not_returnable', 'Only delivered orders can be returned');
    const policy = order.cancellationPolicy as PolicySnapshot | null;
    if (!withinReturnWindow(policy, order.fulfilledAt ?? order.updatedAt)) {
      throw conflict('return_window_closed', policy?.returnWindowDays ? `Returns are accepted within ${policy.returnWindowDays} days of delivery` : 'This supplier does not accept returns');
    }

    const open = await this.prisma.returnRequest.findMany({ where: { orderId, status: { in: ['requested', 'approved'] } } });
    const pending = new Map<string, Prisma.Decimal>();
    for (const r of open) for (const l of r.lines as Line[]) pending.set(l.orderLineId, (pending.get(l.orderLineId) ?? new Decimal(0)).plus(l.quantity));

    let amount = new Decimal(0);
    for (const l of dto.lines) {
      const line = order.lines.find((x) => x.id === l.orderLineId);
      if (!line) throw badRequest('unknown_line', 'A return line does not belong to this order');
      const quantity = new Decimal(l.quantity);
      if (quantity.lte(0)) throw badRequest('invalid_quantity', 'Return quantities must be more than 0');
      const returnable = line.fulfilledQuantity.minus(line.returnedQuantity).minus(pending.get(line.id) ?? 0);
      if (quantity.gt(returnable)) throw badRequest('over_return', `Line ${line.lineNumber}: at most ${returnable.toString()} can be returned`);
      amount = amount.plus(quantity.times(line.unitPrice));
    }
    const restockingFee = amount.times(policy?.restockingFeePct ?? 0).dividedBy(100).toDecimalPlaces(2);

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.returnRequest.create({
        data: {
          number: await this.nextNumber(tx),
          orderId,
          buyerOrganizationId: order.buyerOrganizationId,
          supplierOrganizationId: order.supplierOrganizationId,
          reason: dto.reason.trim(),
          lines: dto.lines.map((l) => ({ orderLineId: l.orderLineId, quantity: new Decimal(l.quantity).toString() })),
          currency: order.currency,
          amount: amount.toDecimalPlaces(4),
          restockingFee,
          evidenceDocumentIds: dto.evidenceDocumentIds ?? [],
          requestedByUserId: userId,
        },
      });
      await this.orders.emit(tx, 'ReturnRequested', created.id, {
        returnId: created.id,
        orderId,
        orderNumber: order.number,
        buyerOrganizationId: order.buyerOrganizationId,
        supplierOrganizationId: order.supplierOrganizationId,
        reason: created.reason,
      });
      return created;
    });
  }

  async list(org: ActingOrganization, side: OrderParty, query: ListReturnsQueryDto) {
    requireRole(org, READ_ROLES, 'view returns');
    const where: Prisma.ReturnRequestWhereInput = {
      [side === 'buyer' ? 'buyerOrganizationId' : 'supplierOrganizationId']: org.organization.id,
      ...(query.status ? { status: query.status } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.returnRequest.findMany({ where, include: { order: { select: { number: true } } }, orderBy: { createdAt: 'desc' }, ...skipTake(query) }),
      this.prisma.returnRequest.count({ where }),
    ]);
    return toPage(items, total, query);
  }

  async get(org: ActingOrganization, side: OrderParty, returnId: string) {
    requireRole(org, READ_ROLES, 'view returns');
    return this.owned(org, side, returnId);
  }

  async decide(org: ActingOrganization, userId: string, returnId: string, dto: ReturnDecisionDto) {
    requireRole(org, SUPPLIER_ROLES, 'decide on returns');
    const ret = await this.owned(org, 'supplier', returnId);
    if (ret.status !== 'requested') throw conflict('invalid_transition', `A ${ret.status} return cannot be decided`);
    if (dto.decision === 'reject' && !dto.note?.trim()) throw badRequest('reason_required', 'Explain why the return is rejected');
    return this.change(ret, dto.decision === 'approve' ? 'approved' : 'rejected', userId, dto.note?.trim() || null);
  }

  /** The goods are back: returned quantities go on the order lines and Finance is told what to refund. */
  async receive(org: ActingOrganization, userId: string, returnId: string) {
    requireRole(org, [...SUPPLIER_ROLES, 'warehouse_operator'], 'receive returns');
    const ret = await this.owned(org, 'supplier', returnId);
    if (ret.status !== 'approved') throw conflict('invalid_transition', `A ${ret.status} return cannot be received`);
    return this.change(ret, 'received', userId, null);
  }

  /** The buyer withdraws a return that hasn't been received yet. */
  async cancel(org: ActingOrganization, userId: string, returnId: string) {
    requireRole(org, BUYER_ROLES, 'cancel returns');
    const ret = await this.owned(org, 'buyer', returnId);
    if (!['requested', 'approved'].includes(ret.status)) throw conflict('invalid_transition', `A ${ret.status} return cannot be cancelled`);
    return this.change(ret, 'cancelled', userId, null);
  }

  private change(ret: ReturnRequest & { order: { number: string } }, status: 'approved' | 'rejected' | 'received' | 'cancelled', userId: string, note: string | null) {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.returnRequest.updateMany({
        where: { id: ret.id, status: ret.status },
        data: {
          status,
          ...(status === 'approved' || status === 'rejected' ? { decidedByUserId: userId, decidedAt: new Date(), decisionNote: note } : {}),
          ...(status === 'received' ? { receivedAt: new Date() } : {}),
        },
      });
      if (count === 0) throw conflict('concurrent_change', 'The return changed; reload and try again');
      if (status === 'received') {
        for (const l of ret.lines as Line[]) await tx.orderLine.update({ where: { id: l.orderLineId }, data: { returnedQuantity: { increment: l.quantity } } });
      }
      if (status !== 'cancelled') {
        await this.orders.emit(tx, 'ReturnStatusChanged', ret.id, {
          returnId: ret.id,
          orderId: ret.orderId,
          orderNumber: ret.order.number,
          buyerOrganizationId: ret.buyerOrganizationId,
          supplierOrganizationId: ret.supplierOrganizationId,
          status,
          refundAmount: ret.amount.minus(ret.restockingFee).toDecimalPlaces(2).toString(),
          currency: ret.currency,
          note,
        });
      }
      return tx.returnRequest.findUniqueOrThrow({ where: { id: ret.id }, include: { order: { select: { number: true } } } });
    });
  }

  private async owned(org: ActingOrganization, side: OrderParty, returnId: string) {
    const ret = await this.prisma.returnRequest.findFirst({
      where: { id: returnId, [side === 'buyer' ? 'buyerOrganizationId' : 'supplierOrganizationId']: org.organization.id },
      include: { order: { select: { number: true } } },
    });
    if (!ret) throw notFound('Return');
    return ret;
  }

  /** RMA-<year>-<6 digits>, sharing the order counter table under a negative year key. */
  private async nextNumber(tx: Tx) {
    const year = new Date().getUTCFullYear();
    const key = -year;
    const [row] = await tx.$queryRaw<{ last: number }[]>`
      INSERT INTO ${Prisma.raw(qualified('order_number_counters'))} (year, last) VALUES (${key}, 1)
      ON CONFLICT (year) DO UPDATE SET last = order_number_counters.last + 1
      RETURNING last`;
    return `RMA-${year}-${String(row!.last).padStart(6, '0')}`;
  }
}
