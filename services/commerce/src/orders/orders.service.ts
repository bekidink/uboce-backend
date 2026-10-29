import { createHash } from 'node:crypto';

import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type ActingOrganization,
  AppError,
  badRequest,
  buildEvent,
  CatalogClient,
  conflict,
  InternalCallError,
  locationScope,
  notFound,
  OrganizationsClient,
  qualified,
  requireApprovalLimit,
  requireLocation,
  requirePermission,
  requireRole,
  skipTake,
  toOutboxRow,
  toPage,
} from '@uboce/common';
import type { CatalogQuote, DomainEvent, EventCatalog, EventType, InternalOrder } from '@uboce/contracts';

import { SERVICE_NAME } from '../config.js';
import { Prisma } from '../generated/prisma/client.js';
import type { Order, OrderStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma.service.js';
import type { CreateDirectOrderDto, FulfillmentLocationDto, ListOrdersQueryDto } from './orders.dto.js';
import { snapshotOf } from './policies.service.js';
import { type AppliedPromotion, PromotionsService } from './promotions.service.js';
import { assertTransition, canTransition, cancellationFeePct, InvalidTransitionError, type OrderParty, type PolicySnapshot } from './state-machine.js';

type Tx = Prisma.TransactionClient;
const { Decimal } = Prisma;

export const BUYER_ROLES = ['owner', 'admin', 'procurement_officer'];
export const SUPPLIER_ROLES = ['owner', 'admin', 'sales_representative'];
/** Supplier staff who hand goods over or record delivery problems. */
const FULFILMENT_ROLES = [...SUPPLIER_ROLES, 'warehouse_operator', 'logistics_operator'];
export const READ_ROLES = [...BUYER_ROLES, ...SUPPLIER_ROLES, 'finance_officer', 'auditor', 'warehouse_operator', 'logistics_operator'];

export const orderInclude = {
  lines: { orderBy: { lineNumber: 'asc' } },
  history: { orderBy: { createdAt: 'asc' } },
  fulfillmentChanges: { orderBy: { createdAt: 'asc' } },
} as const;
export type FullOrder = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

interface NewLine {
  productId?: string | null;
  variantId?: string | null;
  sku?: string | null;
  description: string;
  quantity: string;
  unitOfMeasure: string;
  unitPrice: string;
  listPrice?: string | null;
  priceSource: string;
  leadTimeDays?: number | null;
  snapshot?: object | null;
}

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
  fulfillmentMethod?: 'delivery' | 'pickup';
  fulfillmentBranchId?: string | null;
  preorder?: boolean;
  createdByUserId: string;
  lines: NewLine[];
  promotion?: AppliedPromotion | null;
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

const invalidTransition = (error: unknown) => (error instanceof InvalidTransitionError ? conflict('invalid_transition', error.message) : error);

/** Catalog's 422 problems (MOQ, season, options…) pass through to the buyer unchanged. */
const quoteFailure = (error: unknown) => {
  if (error instanceof InternalCallError && error.status && error.status < 500) {
    const body = (error as { body?: { error?: { code?: string; message?: string } } }).body;
    return new AppError(HttpStatus.UNPROCESSABLE_ENTITY, body?.error?.code ?? 'invalid_line', body?.error?.message ?? 'An order line is not valid');
  }
  return error;
};

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationsClient,
    private readonly catalog: CatalogClient,
    private readonly promotions: PromotionsService,
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
      lines: q.lines.map((l) => ({ ...l, priceSource: 'agreed' })),
    });
  }

  /**
   * Direct order with an Idempotency-Key (PRD 8.1): retrying the same request
   * returns the same order; reusing the key for a different request is refused.
   * Catalog lines are priced by Catalog (PRD addendum 2.3–2.4), never by the buyer.
   */
  async createDirect(org: ActingOrganization, userId: string, idempotencyKey: string, dto: CreateDirectOrderDto) {
    requireRole(org, BUYER_ROLES, 'place orders');
    requirePermission(org, 'purchase_orders:approve', 'place orders');
    const buyerId = org.organization.id;
    if (dto.supplierOrganizationId === buyerId) throw badRequest('self_order', 'You cannot order from your own organization');
    const requestHash = createHash('sha256').update(stableStringify(dto)).digest('hex');

    const replay = await this.findByKey(buyerId, idempotencyKey, requestHash);
    if (replay) return { order: replay, replayed: true };

    const supplier = await this.organizations.getOrganization(dto.supplierOrganizationId);
    if (!supplier || supplier.status !== 'active') throw badRequest('unknown_supplier', 'Supplier does not exist or is inactive');

    const method = dto.fulfillmentMethod ?? 'delivery';
    if (method === 'pickup' && !dto.fulfillmentBranchId) throw badRequest('pickup_location_required', 'Choose the pickup location');
    if (dto.fulfillmentBranchId) {
      const branch = await this.organizations.getBranch(dto.supplierOrganizationId, dto.fulfillmentBranchId);
      if (!branch || !branch.active) throw badRequest('unknown_location', 'That location does not exist');
      if (method === 'pickup' && !branch.pickupEnabled) throw badRequest('no_pickup', 'Orders cannot be collected at that location');
    }

    const lines = await this.priceLines(dto, buyerId);
    const subtotal = lines.reduce((s, l) => s.plus(new Decimal(l.quantity).times(l.unitPrice)), new Decimal(0));
    const promotion = await this.promotions.best(this.prisma, dto.supplierOrganizationId, buyerId, dto.currency, subtotal, dto.couponCode);
    requireApprovalLimit(org, subtotal.minus(promotion?.discount ?? 0).toString(), dto.currency, 'place orders');

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
          fulfillmentMethod: method,
          fulfillmentBranchId: dto.fulfillmentBranchId ?? null,
          preorder: lines.some((l) => (l.snapshot as { preorder?: boolean } | null)?.preorder),
          createdByUserId: userId,
          lines,
          promotion,
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

  /** Catalog lines get catalog prices and snapshots; free-text lines keep the buyer's price, labelled as such. */
  private async priceLines(dto: CreateDirectOrderDto, buyerId: string): Promise<NewLine[]> {
    dto.lines.forEach((l, i) => {
      if (!l.variantId && l.productId) throw badRequest('variant_required', `Line ${i + 1}: order catalog products by variant (variantId)`);
      if (!l.variantId && (!l.description || !l.unitPrice || !l.unitOfMeasure)) {
        throw badRequest('incomplete_line', `Line ${i + 1}: free-text lines need a description, unit and unit price`);
      }
    });
    const catalogLines = dto.lines.filter((l) => l.variantId);
    let quote: CatalogQuote | null = null;
    if (catalogLines.length) {
      quote = await this.catalog
        .quote({
          supplierOrganizationId: dto.supplierOrganizationId,
          buyerOrganizationId: buyerId,
          currency: dto.currency,
          branchId: dto.fulfillmentBranchId ?? null,
          lines: catalogLines.map((l) => ({ variantId: l.variantId!, quantity: l.quantity, optionIds: l.optionIds })),
        })
        .catch((error: unknown) => {
          throw quoteFailure(error);
        });
    }
    let q = 0;
    return dto.lines.map((l) => {
      if (!l.variantId) {
        return { description: l.description!, quantity: l.quantity, unitOfMeasure: l.unitOfMeasure!, unitPrice: l.unitPrice!, priceSource: 'buyer_entered' };
      }
      const priced = quote!.lines[q++]!;
      return {
        productId: priced.productId,
        variantId: priced.variantId,
        sku: priced.snapshot.sku,
        description: priced.description,
        quantity: priced.quantity,
        unitOfMeasure: priced.unitOfMeasure,
        unitPrice: priced.unitPrice,
        listPrice: priced.listPrice,
        priceSource: priced.priceSource,
        leadTimeDays: priced.leadTimeDays,
        snapshot: priced.snapshot,
      };
    });
  }

  async list(org: ActingOrganization, side: OrderParty, query: ListOrdersQueryDto) {
    requireRole(org, READ_ROLES, 'view orders');
    const where: Prisma.OrderWhereInput = {
      [side === 'buyer' ? 'buyerOrganizationId' : 'supplierOrganizationId']: org.organization.id,
      ...(query.status ? { status: query.status } : {}),
      ...(query.quotationId ? { sourceQuotationId: query.quotationId } : {}),
      ...(query.fulfillmentBranchId ? { fulfillmentBranchId: query.fulfillmentBranchId } : {}),
      ...this.supplierScope(org, side),
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
    requirePermission(org, 'orders:confirm', 'confirm orders');
    return this.move(org, 'supplier', userId, orderId, 'confirmed', null);
  }

  /** A buyer cancelling after the free window pays the fee from the order's policy snapshot. */
  async cancel(org: ActingOrganization, side: OrderParty, userId: string, orderId: string, reason: string | null) {
    requireRole(org, side === 'buyer' ? BUYER_ROLES : SUPPLIER_ROLES, 'cancel orders');
    return this.move(org, side, userId, orderId, 'cancelled', reason);
  }

  // ---- Pickup and delivery problems (PRD addendum 2.6, 2.8) ------------------------------

  async readyForPickup(org: ActingOrganization, userId: string, orderId: string) {
    requireRole(org, FULFILMENT_ROLES, 'prepare pickups');
    const order = await this.owned(org, 'supplier', orderId);
    if (order.fulfillmentMethod !== 'pickup') throw conflict('not_pickup', 'This order is delivered, not collected');
    return this.move(org, 'supplier', userId, orderId, 'ready_for_pickup', null);
  }

  /** The buyer collected the goods: every line is fulfilled and Inventory issues the reserved stock. */
  async collected(org: ActingOrganization, userId: string, orderId: string) {
    requireRole(org, FULFILMENT_ROLES, 'hand over pickups');
    return this.move(org, 'supplier', userId, orderId, 'fulfilled', 'collected by the buyer');
  }

  /** No-show: the pickup wasn't collected within the hold time. The policy's no-show fee applies. */
  async uncollected(org: ActingOrganization, userId: string, orderId: string, reason: string | null) {
    requireRole(org, FULFILMENT_ROLES, 'record no-shows');
    const order = await this.owned(org, 'supplier', orderId);
    const policy = order.cancellationPolicy as PolicySnapshot | null;
    const readyAt = [...order.history].reverse().find((h) => h.toStatus === 'ready_for_pickup')?.createdAt;
    if (policy && readyAt && Date.now() < readyAt.getTime() + policy.pickupHoldHours * 3_600_000) {
      throw conflict('pickup_hold', `Pickups are held for ${policy.pickupHoldHours} hours before they count as uncollected`);
    }
    return this.move(org, 'supplier', userId, orderId, 'uncollected', reason ?? 'not collected');
  }

  async deliveryFailed(org: ActingOrganization, userId: string, orderId: string, reason: string | null) {
    requireRole(org, FULFILMENT_ROLES, 'record failed deliveries');
    return this.move(org, 'supplier', userId, orderId, 'delivery_failed', reason ?? 'delivery failed');
  }

  /** Try again after a failed delivery (or book a new pickup after a no-show). */
  async retry(org: ActingOrganization, userId: string, orderId: string) {
    requireRole(org, FULFILMENT_ROLES, 'retry fulfilment');
    const order = await this.owned(org, 'supplier', orderId);
    const to: OrderStatus = order.status === 'uncollected' ? 'ready_for_pickup' : 'confirmed';
    return this.move(org, 'supplier', userId, orderId, to, 'retry');
  }

  /** Which supplier location fulfils the order; every change is kept (PRD addendum 2.1). */
  async assignFulfillment(org: ActingOrganization, userId: string, orderId: string, dto: FulfillmentLocationDto) {
    requireRole(org, SUPPLIER_ROLES, 'assign fulfilment locations');
    requireLocation(org, dto.branchId, 'assign orders to that location');
    const order = await this.owned(org, 'supplier', orderId);
    if (['fulfilled', 'closed', 'cancelled'].includes(order.status)) throw conflict('order_finished', `A ${order.status} order cannot be reassigned`);
    const branch = await this.organizations.getBranch(org.organization.id, dto.branchId);
    if (!branch || !branch.active) throw notFound('Location');
    if (order.fulfillmentMethod === 'pickup' && !branch.pickupEnabled) throw badRequest('no_pickup', 'Orders cannot be collected at that location');
    if (order.fulfillmentMethod === 'delivery' && !branch.fulfillment) throw badRequest('no_fulfilment', 'That location does not ship orders');
    if (order.fulfillmentBranchId === dto.branchId) return order;
    return this.prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id: orderId }, data: { fulfillmentBranchId: dto.branchId } });
      await tx.orderFulfillmentChange.create({
        data: { orderId, fromBranchId: order.fulfillmentBranchId, toBranchId: dto.branchId, changedByUserId: userId, reason: dto.reason?.trim() || null },
      });
      return tx.order.findUniqueOrThrow({ where: { id: orderId }, include: orderInclude });
    });
  }

  /** The buyer closes a fulfilled order (PRD 5.8: closure). */
  async close(org: ActingOrganization, userId: string, orderId: string) {
    requireRole(org, BUYER_ROLES, 'close orders');
    return this.move(org, 'buyer', userId, orderId, 'closed', null);
  }

  /** Every user-driven status change: checks, conditional update, history, fees and events. */
  private async move(org: ActingOrganization, side: OrderParty, userId: string, orderId: string, to: OrderStatus, reason: string | null) {
    const order = await this.owned(org, side, orderId);
    try {
      assertTransition(order.status, to, side);
    } catch (error) {
      throw invalidTransition(error);
    }
    const policy = order.cancellationPolicy as PolicySnapshot | null;
    let fee: Prisma.Decimal | null = null;
    let feeKind: 'cancellation_fee' | 'no_show_fee' | null = null;
    if (to === 'cancelled' && side === 'buyer') {
      const pct = cancellationFeePct(policy, order.status, order.confirmedAt);
      if (pct > 0) {
        fee = order.total.times(pct).dividedBy(100).toDecimalPlaces(2);
        feeKind = 'cancellation_fee';
      }
    }
    if (to === 'uncollected' && policy && Number(policy.noShowFeePct) > 0) {
      fee = order.total.times(policy.noShowFeePct).dividedBy(100).toDecimalPlaces(2);
      feeKind = 'no_show_fee';
    }

    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      // Conditional on the status we checked, so concurrent changes can't both apply.
      const { count } = await tx.order.updateMany({
        where: { id: orderId, status: order.status },
        data: {
          status: to,
          ...(to === 'confirmed' && !order.confirmedAt ? { confirmedAt: now } : {}),
          ...(to === 'fulfilled' ? { fulfilledAt: now } : {}),
          ...(fee ? { cancellationFee: fee } : {}),
        },
      });
      if (count === 0) throw conflict('concurrent_change', 'The order changed; reload and try again');
      await tx.orderStatusHistory.create({ data: { orderId, fromStatus: order.status, toStatus: to, changedByUserId: userId, reason } });
      if (to === 'fulfilled') {
        for (const l of order.lines) await tx.orderLine.update({ where: { id: l.id }, data: { fulfilledQuantity: l.quantity } });
      }

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
      if (to === 'confirmed' && order.status === 'pending_confirmation') {
        // Lines ride along so Inventory can reserve stock without calling back.
        await this.emit(tx, 'PurchaseOrderConfirmed', orderId, {
          ...change,
          lines: order.lines.map((l) => ({ orderLineId: l.id, productId: l.productId, quantity: l.quantity.toString(), unitOfMeasure: l.unitOfMeasure })),
        });
      } else if (to === 'cancelled') {
        await this.emit(tx, 'PurchaseOrderCancelled', orderId, { ...change, cancellationFee: fee?.toString() ?? null });
      } else {
        await this.announceFulfillment(tx, { ...order, status: to }, to === 'fulfilled' && order.fulfillmentMethod === 'pickup');
      }
      if (fee && feeKind) {
        await this.emit(tx, 'OrderChargeAssessed', orderId, {
          orderId,
          orderNumber: order.number,
          buyerOrganizationId: order.buyerOrganizationId,
          supplierOrganizationId: order.supplierOrganizationId,
          kind: feeKind,
          amount: fee.toString(),
          currency: order.currency,
          policyVersion: policy?.version ?? null,
        });
      }
      return tx.order.findUniqueOrThrow({ where: { id: orderId }, include: orderInclude });
    });
  }

  // ---- System-driven changes (events from Inventory and Logistics) -------------------

  /** Stock couldn't be reserved: the order needs human attention (PRD 8.5: defined exception state). */
  async markException(tx: Tx, orderId: string, reason: string) {
    await this.systemMove(tx, orderId, 'exception', reason);
  }

  /** The carrier reported a failed delivery (PRD addendum 2.8). */
  async markDeliveryFailed(tx: Tx, orderId: string, reason: string) {
    await this.systemMove(tx, orderId, 'delivery_failed', reason);
  }

  private async systemMove(tx: Tx, orderId: string, to: OrderStatus, reason: string) {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order || !canTransition(order.status, to, 'system')) return;
    await tx.order.update({ where: { id: orderId }, data: { status: to } });
    await tx.orderStatusHistory.create({ data: { orderId, fromStatus: order.status, toStatus: to, reason } });
    await this.announceFulfillment(tx, { ...order, status: to });
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
    await tx.order.update({ where: { id: orderId }, data: { status: to, ...(to === 'fulfilled' ? { fulfilledAt: new Date() } : {}) } });
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
      discountTotal: order.discountTotal.toString(),
      promotionCode: order.promotionCode,
      fulfillmentBranchId: order.fulfillmentBranchId,
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

  private announceFulfillment(
    tx: Tx,
    order: { id: string; number: string; buyerOrganizationId: string; supplierOrganizationId: string; status: string },
    handover = false,
  ) {
    return this.emit(tx, 'PurchaseOrderFulfillmentUpdated', order.id, {
      orderId: order.id,
      orderNumber: order.number,
      buyerOrganizationId: order.buyerOrganizationId,
      supplierOrganizationId: order.supplierOrganizationId,
      status: order.status,
      ...(handover ? { handover: true } : {}),
    });
  }

  private async insert(tx: Tx, order: NewOrder) {
    const lines = order.lines.map((l, i) => {
      const quantity = new Decimal(l.quantity);
      const unitPrice = new Decimal(l.unitPrice);
      return {
        lineNumber: i + 1,
        productId: l.productId ?? null,
        variantId: l.variantId ?? null,
        sku: l.sku ?? null,
        description: l.description.trim(),
        quantity,
        unitOfMeasure: l.unitOfMeasure,
        unitPrice,
        listPrice: l.listPrice ?? null,
        priceSource: l.priceSource,
        lineTotal: quantity.times(unitPrice).toDecimalPlaces(4),
        leadTimeDays: l.leadTimeDays ?? null,
        snapshot: (l.snapshot ?? undefined) as Prisma.InputJsonValue | undefined,
      };
    });
    const subtotal = lines.reduce((sum, l) => sum.plus(l.lineTotal), new Decimal(0));
    const discount = order.promotion?.discount ?? new Decimal(0);
    const policy = await tx.cancellationPolicy.findFirst({ where: { organizationId: order.supplierOrganizationId, active: true }, orderBy: { version: 'desc' } });
    const { lines: _, promotion, ...header } = order;

    const created = await tx.order.create({
      data: {
        ...header,
        number: await this.nextNumber(tx),
        subtotal,
        discountTotal: discount,
        total: subtotal.minus(discount),
        promotionId: promotion?.promotion.id ?? null,
        promotionCode: promotion?.promotion.code ?? null,
        cancellationPolicy: policy ? (snapshotOf(policy) as unknown as Prisma.InputJsonValue) : undefined,
        lines: { create: lines },
        history: { create: { fromStatus: null, toStatus: 'pending_confirmation', changedByUserId: order.createdByUserId } },
        ...(order.fulfillmentBranchId
          ? { fulfillmentChanges: { create: { toBranchId: order.fulfillmentBranchId, changedByUserId: order.createdByUserId, reason: 'chosen at checkout' } } }
          : {}),
      },
      include: orderInclude,
    });
    if (promotion) await this.promotions.redeem(tx, promotion, created.id, order.buyerOrganizationId);
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

  /** Supplier staff limited to locations see only the orders assigned to those locations. */
  private supplierScope(org: ActingOrganization, side: OrderParty): Prisma.OrderWhereInput {
    const scope = side === 'supplier' ? locationScope(org) : null;
    return scope ? { fulfillmentBranchId: { in: scope } } : {};
  }

  /** Only the two parties to an order can see it, each from their own side. */
  async owned(org: ActingOrganization, side: OrderParty, orderId: string): Promise<FullOrder> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, [side === 'buyer' ? 'buyerOrganizationId' : 'supplierOrganizationId']: org.organization.id, ...this.supplierScope(org, side) },
      include: orderInclude,
    });
    if (!order) throw notFound('Order');
    return order as Order & FullOrder;
  }

  emit<T extends EventType>(tx: Tx, type: T, aggregateId: string, data: EventCatalog[T]) {
    return tx.outboxEvent.create({ data: toOutboxRow(buildEvent(SERVICE_NAME, type, aggregateId, data)) });
  }
}
