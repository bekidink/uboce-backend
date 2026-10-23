import { createHash } from 'node:crypto';

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
  qualified,
} from '@uboce/common';
import type { DomainEvent, EventCatalog, EventType, InternalOrder } from '@uboce/contracts';

import { SERVICE_NAME } from '../config.js';
import { Prisma } from '../generated/prisma/client.js';
import type { Order, OrderStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma.service.js';
import type { CreateDirectOrderDto, ListOrdersQueryDto } from './orders.dto.js';
import { assertTransition, canTransition, InvalidTransitionError, type OrderParty } from './state-machine.js';

type Tx = Prisma.TransactionClient;
const { Decimal } = Prisma;

const BUYER_ROLES = ['owner', 'admin', 'procurement_officer'];
const SUPPLIER_ROLES = ['owner', 'admin', 'sales_representative'];
const READ_ROLES = [...BUYER_ROLES, ...SUPPLIER_ROLES, 'finance_officer', 'auditor', 'warehouse_operator', 'logistics_operator'];

const orderInclude = {
  lines: { orderBy: { lineNumber: 'asc' } },
  history: { orderBy: { createdAt: 'asc' } },
} as const;

interface NewOrder {
  buyerOrganizationId: string;
  supplierOrganizationId: string;
  source: 'quotation' | 'direct';
  sourceQuotationId?: string;
  rfqId?: string;
  idempotencyKey?: string;
  requestHash?: string;
  title?: string | null;
  currency: string;
  deliveryTerms?: string | null;
  deliveryLocation?: string | null;
  createdByUserId: string;
  lines: {
    productId?: string | null;
    description: string;
    quantity: string;
    unitOfMeasure: string;
    unitPrice: string;
    leadTimeDays?: number | null;
  }[];
}

/** Stable JSON (sorted keys) so equal requests hash equally regardless of key order. */
const stableStringify = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(stableStringify).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.keys(value)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
          .join(',')}}`
      : JSON.stringify(value);

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationsClient,
  ) {}

  /** Consumer side of QuotationAccepted. The unique sourceQuotationId makes a second order impossible. */
  async createFromQuotation(tx: Tx, event: DomainEvent<'QuotationAccepted'>) {
    const q = event.data;
    if (await tx.order.findUnique({ where: { sourceQuotationId: q.quotationId } })) return;
    await this.insert(tx, {
      buyerOrganizationId: q.buyerOrganizationId,
      supplierOrganizationId: q.supplierOrganizationId,
      source: 'quotation',
      sourceQuotationId: q.quotationId,
      rfqId: q.rfqId,
      title: q.rfqTitle,
      currency: q.currency,
      deliveryTerms: q.deliveryTerms,
      deliveryLocation: q.deliveryLocation,
      createdByUserId: q.acceptedByUserId,
      lines: q.lines,
    });
  }

  /**
   * Direct order with an Idempotency-Key (PRD 8.1): retrying the same request
   * returns the same order; reusing the key for a different request is refused.
   */
  async createDirect(org: ActingOrganization, userId: string, idempotencyKey: string, dto: CreateDirectOrderDto) {
    requireRole(org, BUYER_ROLES, 'place orders');
    const buyerId = org.organization.id;
    if (dto.supplierOrganizationId === buyerId) throw badRequest('self_order', 'You cannot order from your own organization');
    const requestHash = createHash('sha256').update(stableStringify(dto)).digest('hex');

    const replay = await this.findByKey(buyerId, idempotencyKey, requestHash);
    if (replay) return { order: replay, replayed: true };

    const supplier = await this.organizations.getOrganization(dto.supplierOrganizationId);
    if (!supplier || supplier.status !== 'active') throw badRequest('unknown_supplier', 'Supplier does not exist or is inactive');

    try {
      const order = await this.prisma.$transaction((tx) =>
        this.insert(tx, {
          buyerOrganizationId: buyerId,
          supplierOrganizationId: dto.supplierOrganizationId,
          source: 'direct',
          idempotencyKey,
          requestHash,
          title: dto.title?.trim() || null,
          currency: dto.currency,
          deliveryTerms: dto.deliveryTerms?.trim() || null,
          deliveryLocation: dto.deliveryLocation?.trim() || null,
          createdByUserId: userId,
          lines: dto.lines,
        }),
      );
      return { order, replayed: false };
    } catch (error) {
      // A concurrent retry with the same key won the race.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const winner = await this.findByKey(buyerId, idempotencyKey, requestHash);
        if (winner) return { order: winner, replayed: true };
      }
      throw error;
    }
  }

  async list(org: ActingOrganization, side: OrderParty, query: ListOrdersQueryDto) {
    requireRole(org, READ_ROLES, 'view orders');
    const where: Prisma.OrderWhereInput = {
      [side === 'buyer' ? 'buyerOrganizationId' : 'supplierOrganizationId']: org.organization.id,
      ...(query.status ? { status: query.status } : {}),
      ...(query.quotationId ? { sourceQuotationId: query.quotationId } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.order.findMany({ where, include: { lines: { orderBy: { lineNumber: 'asc' } } }, orderBy: { createdAt: 'desc' }, ...skipTake(query) }),
      this.prisma.order.count({ where }),
    ]);
    return toPage(items, total, query);
  }

  async get(org: ActingOrganization, side: OrderParty, orderId: string) {
    requireRole(org, READ_ROLES, 'view orders');
    return this.owned(org, side, orderId);
  }

  async confirm(org: ActingOrganization, userId: string, orderId: string) {
    requireRole(org, SUPPLIER_ROLES, 'confirm orders');
    return this.transition(org, 'supplier', userId, orderId, 'confirmed', null, 'PurchaseOrderConfirmed');
  }

  async cancel(org: ActingOrganization, side: OrderParty, userId: string, orderId: string, reason: string | null) {
    requireRole(org, side === 'buyer' ? BUYER_ROLES : SUPPLIER_ROLES, 'cancel orders');
    return this.transition(org, side, userId, orderId, 'cancelled', reason, 'PurchaseOrderCancelled');
  }

  private async transition(
    org: ActingOrganization,
    side: OrderParty,
    userId: string,
    orderId: string,
    to: OrderStatus,
    reason: string | null,
    eventType: 'PurchaseOrderConfirmed' | 'PurchaseOrderCancelled',
  ) {
    const order = await this.owned(org, side, orderId);
    try {
      assertTransition(order.status, to, side);
    } catch (error) {
      if (error instanceof InvalidTransitionError) throw conflict('invalid_transition', error.message);
      throw error;
    }

    return this.prisma.$transaction(async (tx) => {
      // Conditional on the status we checked, so concurrent changes can't both apply.
      const { count } = await tx.order.updateMany({ where: { id: orderId, status: order.status }, data: { status: to } });
      if (count === 0) throw conflict('concurrent_change', 'The order changed; reload and try again');
      await tx.orderStatusHistory.create({ data: { orderId, fromStatus: order.status, toStatus: to, changedByUserId: userId, reason } });
      const change = {
        party: side,
        orderId,
        orderNumber: order.number,
        buyerOrganizationId: order.buyerOrganizationId,
        supplierOrganizationId: order.supplierOrganizationId,
        status: to,
        changedByUserId: userId,
        reason,
      };
      if (eventType === 'PurchaseOrderConfirmed') {
        // Lines ride along so Inventory can reserve stock without calling back.
        await this.emit(tx, 'PurchaseOrderConfirmed', orderId, {
          ...change,
          lines: order.lines.map((l) => ({
            orderLineId: l.id,
            productId: l.productId,
            quantity: l.quantity.toString(),
            unitOfMeasure: l.unitOfMeasure,
          })),
        });
      } else {
        await this.emit(tx, 'PurchaseOrderCancelled', orderId, change);
      }
      return tx.order.findUniqueOrThrow({ where: { id: orderId }, include: orderInclude });
    });
  }

  /** The buyer closes a fulfilled order (PRD 5.8: closure). */
  async close(org: ActingOrganization, userId: string, orderId: string) {
    requireRole(org, BUYER_ROLES, 'close orders');
    const order = await this.owned(org, 'buyer', orderId);
    try {
      assertTransition(order.status, 'closed', 'buyer');
    } catch (error) {
      if (error instanceof InvalidTransitionError) throw conflict('invalid_transition', error.message);
      throw error;
    }
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.order.updateMany({ where: { id: orderId, status: order.status }, data: { status: 'closed' } });
      if (count === 0) throw conflict('concurrent_change', 'The order changed; reload and try again');
      await tx.orderStatusHistory.create({ data: { orderId, fromStatus: order.status, toStatus: 'closed', changedByUserId: userId } });
      await this.announceFulfillment(tx, { ...order, status: 'closed' });
      return tx.order.findUniqueOrThrow({ where: { id: orderId }, include: orderInclude });
    });
  }

  // ---- System-driven changes (events from Inventory and Logistics) -------------------

  /** Stock couldn't be reserved: the order needs human attention (PRD 8.5: defined exception state). */
  async markException(tx: Tx, orderId: string, reason: string) {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order || !canTransition(order.status, 'exception', 'system')) return;
    await tx.order.update({ where: { id: orderId }, data: { status: 'exception' } });
    await tx.orderStatusHistory.create({ data: { orderId, fromStatus: order.status, toStatus: 'exception', reason } });
    await this.announceFulfillment(tx, { ...order, status: 'exception' });
  }

  /** Applies delivered quantities to the lines; fulfilled once every line is fully delivered. */
  async applyDelivery(tx: Tx, orderId: string, items: { orderLineId: string; deliveredQuantity: string }[]) {
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { lines: true } });
    if (!order) return;
    for (const item of items) {
      const line = order.lines.find((l) => l.id === item.orderLineId);
      if (!line) continue;
      const fulfilled = Decimal.min(line.quantity, line.fulfilledQuantity.plus(item.deliveredQuantity));
      await tx.orderLine.update({ where: { id: line.id }, data: { fulfilledQuantity: fulfilled } });
    }
    const lines = await tx.orderLine.findMany({ where: { orderId } });
    const to: OrderStatus = lines.every((l) => l.fulfilledQuantity.greaterThanOrEqualTo(l.quantity)) ? 'fulfilled' : 'partially_fulfilled';
    if (order.status === to || !canTransition(order.status, to, 'system')) return;
    await tx.order.update({ where: { id: orderId }, data: { status: to } });
    await tx.orderStatusHistory.create({ data: { orderId, fromStatus: order.status, toStatus: to, reason: 'delivery confirmed' } });
    await this.announceFulfillment(tx, { ...order, status: to });
  }

  async internalGet(orderId: string): Promise<InternalOrder> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { lines: { orderBy: { lineNumber: 'asc' } } } });
    if (!order) throw notFound('Order');
    return {
      id: order.id,
      number: order.number,
      buyerOrganizationId: order.buyerOrganizationId,
      supplierOrganizationId: order.supplierOrganizationId,
      status: order.status,
      currency: order.currency,
      total: order.total.toString(),
      deliveryLocation: order.deliveryLocation,
      lines: order.lines.map((l) => ({
        id: l.id,
        lineNumber: l.lineNumber,
        productId: l.productId,
        description: l.description,
        quantity: l.quantity.toString(),
        unitOfMeasure: l.unitOfMeasure,
        unitPrice: l.unitPrice.toString(),
        lineTotal: l.lineTotal.toString(),
        fulfilledQuantity: l.fulfilledQuantity.toString(),
      })),
    };
  }

  private announceFulfillment(tx: Tx, order: { id: string; number: string; buyerOrganizationId: string; supplierOrganizationId: string; status: string }) {
    return this.emit(tx, 'PurchaseOrderFulfillmentUpdated', order.id, {
      orderId: order.id,
      orderNumber: order.number,
      buyerOrganizationId: order.buyerOrganizationId,
      supplierOrganizationId: order.supplierOrganizationId,
      status: order.status,
    });
  }

  private async insert(tx: Tx, order: NewOrder) {
    const lines = order.lines.map((l, i) => {
      const quantity = new Decimal(l.quantity);
      const unitPrice = new Decimal(l.unitPrice);
      return {
        lineNumber: i + 1,
        productId: l.productId ?? null,
        description: l.description.trim(),
        quantity,
        unitOfMeasure: l.unitOfMeasure,
        unitPrice,
        lineTotal: quantity.times(unitPrice).toDecimalPlaces(4),
        leadTimeDays: l.leadTimeDays ?? null,
      };
    });
    const total = lines.reduce((sum, l) => sum.plus(l.lineTotal), new Decimal(0));
    const { lines: _, ...header } = order;

    const created = await tx.order.create({
      data: {
        ...header,
        number: await this.nextNumber(tx),
        total,
        lines: { create: lines },
        history: { create: { fromStatus: null, toStatus: 'pending_confirmation', changedByUserId: order.createdByUserId } },
      },
      include: orderInclude,
    });
    await this.emit(tx, 'PurchaseOrderCreated', created.id, {
      orderId: created.id,
      orderNumber: created.number,
      buyerOrganizationId: created.buyerOrganizationId,
      supplierOrganizationId: created.supplierOrganizationId,
      sourceQuotationId: created.sourceQuotationId,
      total: created.total.toFixed(2),
      currency: created.currency,
    });
    return created;
  }

  /** PO-<year>-<6 digits>; the counter row lock serialises numbering within a year. */
  private async nextNumber(tx: Tx) {
    const year = new Date().getUTCFullYear();
    const [row] = await tx.$queryRaw<{ last: number }[]>`
      INSERT INTO ${Prisma.raw(qualified('order_number_counters'))} (year, last) VALUES (${year}, 1)
      ON CONFLICT (year) DO UPDATE SET last = order_number_counters.last + 1
      RETURNING last`;
    return `PO-${year}-${String(row!.last).padStart(6, '0')}`;
  }

  private async findByKey(buyerOrganizationId: string, idempotencyKey: string, requestHash: string) {
    const existing = await this.prisma.order.findUnique({
      where: { buyerOrganizationId_idempotencyKey: { buyerOrganizationId, idempotencyKey } },
      include: orderInclude,
    });
    if (!existing) return null;
    if (existing.requestHash !== requestHash) {
      throw new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'idempotency_key_reused', 'This Idempotency-Key was used for a different order');
    }
    return existing;
  }

  /** Only the two parties to an order can see it, each from their own side. */
  private async owned(org: ActingOrganization, side: OrderParty, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, [side === 'buyer' ? 'buyerOrganizationId' : 'supplierOrganizationId']: org.organization.id },
      include: orderInclude,
    });
    if (!order) throw notFound('Order');
    return order as Order & Prisma.OrderGetPayload<{ include: typeof orderInclude }>;
  }

  private emit<T extends EventType>(tx: Tx, type: T, aggregateId: string, data: EventCatalog[T]) {
    return tx.outboxEvent.create({ data: toOutboxRow(buildEvent(SERVICE_NAME, type, aggregateId, data)) });
  }
}
