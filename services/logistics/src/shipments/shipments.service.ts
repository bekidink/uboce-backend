import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type ActingOrganization,
  AppError,
  badRequest,
  CommerceClient,
  conflict,
  DocumentsClient,
  emitEvent,
  InventoryClient,
  notFound,
  OrganizationsClient,
  type PaginationQueryDto,
  requireRole,
  skipTake,
  toPage,
  WarehousesClient,
} from '@uboce/common';
import type { CarrierTrackingEvent, InternalOrder } from '@uboce/contracts';

import { SERVICE_NAME } from '../config.js';
import { Prisma } from '../generated/prisma/client.js';
import type { FreightPayer, ShipmentStatus } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma.service.js';
import { type Actor, byOrder, canMove, remainingToShip } from './rules.js';

type Tx = Prisma.TransactionClient;
const { Decimal } = Prisma;
export const SHIPPER_ROLES = ['owner', 'admin', 'logistics_operator', 'warehouse_operator', 'sales_representative'];
const CONSIGNEE_ROLES = ['owner', 'admin', 'logistics_operator', 'warehouse_operator', 'procurement_officer'];
/** Drivers are left out on purpose: they only see their own assignments (FleetService). */
const READ_ROLES = [...new Set([...SHIPPER_ROLES, ...CONSIGNEE_ROLES, 'finance_officer', 'auditor'])];
export const include = {
  items: { orderBy: { lineNumber: 'asc' } },
  orders: true,
  packages: true,
  assignments: { include: { driver: true, vehicle: true }, orderBy: { assignedAt: 'desc' } },
  carrier: true,
  tracking: { orderBy: { occurredAt: 'asc' } },
  evidence: true,
  exceptions: true,
} as const;
export type FullShipment = Prisma.ShipmentGetPayload<{ include: typeof include }>;

type Side = 'shipper' | 'consignee' | 'carrier';
const sideField = { shipper: 'shipperOrganizationId', consignee: 'consigneeOrganizationId', carrier: 'carrierOrganizationId' } as const;
/** Staff of a logistics provider who handle shipments handed to them. */
export const CARRIER_ROLES = ['owner', 'admin', 'logistics_operator', 'warehouse_operator'];

export interface CreateShipmentInput {
  orderId: string;
  originWarehouseId?: string;
  destination?: string;
  carrierName?: string;
  carrierId?: string;
  /** Hand the shipment to a logistics provider on UBOCE. */
  carrierOrganizationId?: string;
  trackingNumber?: string;
  expectedDeliveryAt?: string;
  pickupWindowStart?: string;
  pickupWindowEnd?: string;
  freightPayer?: FreightPayer;
  incoterm?: string;
  freightCost?: string;
  freightCurrency?: string;
  /** Lines may come from several orders of the same buyer (consolidation); orderId defaults to the main order. */
  items: { orderLineId: string; quantity: string; orderId?: string }[];
}

@Injectable()
export class ShipmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationsClient,
    private readonly commerce: CommerceClient,
    private readonly inventory: InventoryClient,
    private readonly warehouses: WarehousesClient,
    private readonly documents: DocumentsClient,
  ) {}

  /**
   * The supplier plans a shipment for confirmed orders; quantities can't exceed what's still
   * unshipped. Several orders of the same buyer can travel together (PRD addendum 2.8).
   */
  async create(org: ActingOrganization, userId: string, input: CreateShipmentInput) {
    requireRole(org, SHIPPER_ROLES, 'create shipments');
    const orderIds = [...new Set([input.orderId, ...input.items.map((i) => i.orderId ?? input.orderId)])];
    if (orderIds.length > 20) throw badRequest('too_many_orders', 'A shipment can carry at most 20 orders');
    const orders = new Map<string, InternalOrder>();
    for (const id of orderIds) {
      const order = await this.commerce.getOrder(id);
      if (!order || order.supplierOrganizationId !== org.organization.id) throw notFound('Order');
      if (!['confirmed', 'partially_fulfilled', 'delivery_failed'].includes(order.status)) {
        throw conflict('order_not_shippable', `Order ${order.number} is ${order.status} and cannot be shipped`);
      }
      orders.set(id, order);
    }
    const main = orders.get(input.orderId)!;
    if ([...orders.values()].some((o) => o.buyerOrganizationId !== main.buyerOrganizationId)) {
      throw badRequest('mixed_consignees', 'Consolidated orders must go to the same buyer');
    }
    if (input.originWarehouseId) {
      const warehouse = await this.warehouses.get(input.originWarehouseId);
      if (!warehouse || warehouse.organizationId !== org.organization.id) throw badRequest('unknown_warehouse', 'Warehouse not found in your organization');
    }
    const carrier = input.carrierId ? await this.prisma.carrier.findFirst({ where: { id: input.carrierId, organizationId: org.organization.id, active: true } }) : null;
    if (input.carrierId && !carrier) throw badRequest('unknown_carrier', 'Carrier not found');
    const carrierOrganizationId = input.carrierOrganizationId ?? carrier?.carrierOrganizationId ?? null;
    if (carrierOrganizationId) await this.checkCarrierOrg(org, carrierOrganizationId);
    if (input.pickupWindowStart && input.pickupWindowEnd && new Date(input.pickupWindowStart) >= new Date(input.pickupWindowEnd)) {
      throw badRequest('invalid_window', 'The pickup window must end after it starts');
    }

    const remaining = new Map<string, Prisma.Decimal>();
    const lineInfo = new Map<string, { orderId: string; productId: string | null; description: string }>();
    for (const order of orders.values()) {
      const earlier = await this.prisma.shipmentItem.findMany({
        where: { shipment: { orders: { some: { orderId: order.id } }, status: { notIn: ['cancelled', 'returned'] } }, OR: [{ orderId: order.id }, { orderId: null }] },
        select: { orderLineId: true, quantity: true },
      });
      for (const [lineId, left] of remainingToShip(order.lines, earlier)) remaining.set(lineId, left);
      for (const l of order.lines) lineInfo.set(l.id, { orderId: order.id, productId: l.productId, description: l.description });
    }
    for (const item of input.items) {
      const left = remaining.get(item.orderLineId);
      const info = lineInfo.get(item.orderLineId);
      if (!left || !info || info.orderId !== (item.orderId ?? input.orderId)) throw badRequest('unknown_line', `Order line ${item.orderLineId} is not on that order`);
      if (new Decimal(item.quantity).greaterThan(left)) throw badRequest('over_shipment', `Only ${left.toString()} left to ship on line ${item.orderLineId}`);
      remaining.set(item.orderLineId, left.minus(item.quantity));
    }

    try {
      const created = await this.prisma.shipment.create({
        data: {
          orderId: main.id,
          orderNumber: orders.size > 1 ? `${main.number} +${orders.size - 1}` : main.number,
          shipperOrganizationId: main.supplierOrganizationId,
          consigneeOrganizationId: main.buyerOrganizationId,
          originWarehouseId: input.originWarehouseId,
          destination: input.destination ?? main.deliveryLocation ?? 'As agreed on the order',
          carrierName: input.carrierName,
          carrierId: input.carrierId,
          carrierOrganizationId,
          carrierStatus: carrierOrganizationId ? 'requested' : 'none',
          trackingNumber: input.trackingNumber,
          expectedDeliveryAt: input.expectedDeliveryAt ? new Date(input.expectedDeliveryAt) : null,
          pickupWindowStart: input.pickupWindowStart ? new Date(input.pickupWindowStart) : null,
          pickupWindowEnd: input.pickupWindowEnd ? new Date(input.pickupWindowEnd) : null,
          freightPayer: input.freightPayer ?? 'shipper',
          incoterm: input.incoterm,
          freightCost: input.freightCost,
          freightCurrency: input.freightCost ? (input.freightCurrency ?? main.currency) : null,
          createdByUserId: userId,
          orders: { create: [...orders.values()].map((o) => ({ orderId: o.id, orderNumber: o.number })) },
          items: {
            create: input.items.map((item, i) => {
              const info = lineInfo.get(item.orderLineId)!;
              return { lineNumber: i + 1, orderLineId: item.orderLineId, orderId: info.orderId, itemId: info.productId, description: info.description, quantity: item.quantity };
            }),
          },
        },
        include,
      });
      if (carrierOrganizationId) {
        await this.prisma.$transaction((tx) => this.announceCarrier(tx, created, 'requested', null));
      }
      return created;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw conflict('tracking_number_taken', 'That tracking number is already used');
      }
      throw error;
    }
  }

  /** The carrier must be an active logistics provider, and not the shipper itself. */
  async checkCarrierOrg(org: ActingOrganization, carrierOrganizationId: string) {
    if (carrierOrganizationId === org.organization.id) throw badRequest('self_carrier', 'Use your own fleet instead of naming yourself as carrier');
    const carrier = await this.organizations.getOrganization(carrierOrganizationId);
    if (!carrier || carrier.status !== 'active') throw badRequest('unknown_carrier', 'That logistics provider does not exist or is inactive');
    if (carrier.type !== 'logistics_provider') throw badRequest('not_a_carrier', 'Only logistics providers can carry shipments');
  }

  announceCarrier(tx: Tx, s: { id: string; orderNumber: string; shipperOrganizationId: string; consigneeOrganizationId: string; carrierOrganizationId: string | null }, status: 'requested' | 'accepted' | 'declined' | 'removed', note: string | null, carrierOrganizationId?: string) {
    return emitEvent(tx, SERVICE_NAME, 'ShipmentCarrierChanged', s.id, {
      shipmentId: s.id,
      orderNumber: s.orderNumber,
      shipperOrganizationId: s.shipperOrganizationId,
      consigneeOrganizationId: s.consigneeOrganizationId,
      carrierOrganizationId: (carrierOrganizationId ?? s.carrierOrganizationId)!,
      status,
      note,
    });
  }

  /** Packages on the shipment (replaces the list). */
  async setPackages(org: ActingOrganization, shipmentId: string, packages: { reference: string; weightKg?: string; lengthCm?: string; widthCm?: string; heightCm?: string; contents?: string }[]) {
    requireRole(org, SHIPPER_ROLES, 'pack shipments');
    const shipment = await this.owned(org, shipmentId, 'shipper');
    if (!['created', 'assigned', 'ready_for_pickup'].includes(shipment.status)) throw conflict('already_dispatched', 'Packages can only change before dispatch');
    const refs = packages.map((p) => p.reference.trim());
    if (new Set(refs).size !== refs.length) throw badRequest('duplicate_package', 'Each package needs its own reference');
    return this.prisma.$transaction(async (tx) => {
      await tx.shipmentPackage.deleteMany({ where: { shipmentId } });
      await tx.shipmentPackage.createMany({ data: packages.map((p) => ({ ...p, reference: p.reference.trim(), shipmentId })) });
      return tx.shipment.findUniqueOrThrow({ where: { id: shipmentId }, include });
    });
  }

  /** Packed and waiting for the carrier or driver at the origin. */
  async readyForPickup(org: ActingOrganization, userId: string, shipmentId: string) {
    requireRole(org, SHIPPER_ROLES, 'update shipments');
    const shipment = await this.owned(org, shipmentId, 'shipper');
    if (!canMove(shipment.status, 'ready_for_pickup', 'shipper')) throw conflict('invalid_transition', `A ${shipment.status} shipment cannot be made ready`);
    return this.applyStatus(shipment, 'ready_for_pickup', `user:${userId}`, new Date(), {});
  }

  /**
   * Dispatch issues stock from the origin warehouse, drawing down each order's
   * reservation. Each line posts with a fixed idempotency key, so if a line
   * fails, fixing stock and dispatching again completes it without double issues.
   */
  async dispatch(org: ActingOrganization, userId: string, shipmentId: string) {
    requireRole(org, SHIPPER_ROLES, 'dispatch shipments');
    const shipment = await this.owned(org, shipmentId, 'shipper');
    if (!canMove(shipment.status, 'dispatched', 'shipper')) throw conflict('invalid_transition', `A ${shipment.status} shipment cannot be dispatched`);

    if (shipment.originWarehouseId) {
      for (const item of shipment.items) {
        if (!item.itemId) continue;
        try {
          await this.inventory.postMovement({
            idempotencyKey: `shipment:${shipment.id}:${item.lineNumber}`,
            organizationId: shipment.shipperOrganizationId,
            warehouseId: shipment.originWarehouseId,
            itemId: item.itemId,
            type: 'issue',
            quantity: `-${item.quantity.toString()}`,
            sourceType: 'shipment',
            sourceId: shipment.id,
            reservation: { referenceType: 'order', referenceId: item.orderId ?? shipment.orderId },
          });
        } catch (error) {
          const body = (error as { body?: { error?: { code?: string; message?: string } } }).body;
          throw new AppError(HttpStatus.CONFLICT, body?.error?.code ?? 'stock_issue_failed', `Line ${item.lineNumber}: ${body?.error?.message ?? 'stock could not be issued'}`);
        }
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const { count } = await tx.shipment.updateMany({ where: { id: shipmentId, status: shipment.status }, data: { status: 'dispatched', dispatchedAt: now } });
      if (count === 0) throw conflict('concurrent_change', 'The shipment changed; reload and try again');
      await tx.trackingEvent.create({ data: { shipmentId, status: 'dispatched', source: `user:${userId}`, occurredAt: now } });
      // One event per order, so each order's reservation and fulfilment are handled separately.
      for (const [orderId, items] of byOrder(shipment.items, shipment.orderId)) {
        await emitEvent(tx, SERVICE_NAME, 'ShipmentDispatched', shipmentId, {
          shipmentId,
          orderId,
          shipperOrganizationId: shipment.shipperOrganizationId,
          consigneeOrganizationId: shipment.consigneeOrganizationId,
          originWarehouseId: shipment.originWarehouseId,
          items: items.map((i) => ({ orderLineId: i.orderLineId, itemId: i.itemId, quantity: i.quantity.toString() })),
          dispatchedAt: now.toISOString(),
        });
      }
      await this.announce(tx, shipment, 'dispatched', null);
      return tx.shipment.findUniqueOrThrow({ where: { id: shipmentId }, include });
    });
  }

  /** In-transit updates, delays, failures and returns from the shipper. */
  async track(org: ActingOrganization, userId: string, shipmentId: string, status: ShipmentStatus, location?: string, note?: string) {
    const shipment = await this.visible(org, shipmentId);
    const asCarrier = shipment.carrierOrganizationId === org.organization.id && shipment.shipperOrganizationId !== org.organization.id;
    if (asCarrier) {
      requireRole(org, CARRIER_ROLES, 'update shipments');
      if (shipment.carrierStatus !== 'accepted') throw conflict('not_accepted', 'Accept the shipment first');
    } else {
      requireRole(org, SHIPPER_ROLES, 'update shipments');
      if (shipment.shipperOrganizationId !== org.organization.id) throw notFound('Shipment');
    }
    const actor = asCarrier ? 'carrier' : 'shipper';
    if (!canMove(shipment.status, status, actor)) throw conflict('invalid_transition', `Cannot move a ${shipment.status} shipment to ${status}`);
    return this.applyStatus(shipment, status, `${asCarrier ? 'carrier-org' : 'user'}:${userId}`, new Date(), { location, note });
  }

  /** A driver's update on an assigned shipment (picked up, in transit, delayed, failed). */
  async driverUpdate(shipment: FullShipment, userId: string, status: ShipmentStatus, location?: string, note?: string) {
    if (!canMove(shipment.status, status, 'driver')) throw conflict('invalid_transition', `Cannot move a ${shipment.status} shipment to ${status}`);
    return this.applyStatus(shipment, status, `driver:${userId}`, new Date(), { location, note });
  }

  /** Carrier callbacks, verified by the Integration service. Duplicates are ignored. */
  async carrierEvent(event: CarrierTrackingEvent) {
    const shipment = await this.prisma.shipment.findUnique({ where: { trackingNumber: event.trackingNumber }, include });
    if (!shipment) throw notFound('Shipment');
    const seen = await this.prisma.trackingEvent.findUnique({ where: { externalEventId: `${event.provider}:${event.externalEventId}` } });
    if (seen) return { applied: false };
    // Carriers can report delivery, but only the consignee's confirmation completes it.
    const status = (event.status === 'delivered' ? 'in_transit' : event.status) as ShipmentStatus;
    if (!canMove(shipment.status, status, 'carrier')) {
      await this.prisma.trackingEvent.create({
        data: {
          shipmentId: shipment.id,
          status: shipment.status,
          location: event.location,
          note: `carrier reported ${event.status}`,
          source: `carrier:${event.provider}`,
          externalEventId: `${event.provider}:${event.externalEventId}`,
          occurredAt: new Date(event.occurredAt),
        },
      });
      return { applied: false };
    }
    await this.applyStatus(shipment, status, `carrier:${event.provider}`, new Date(event.occurredAt), {
      location: event.location,
      note: event.status === 'delivered' ? 'carrier reports delivered; awaiting consignee confirmation' : undefined,
      externalEventId: `${event.provider}:${event.externalEventId}`,
    });
    return { applied: true };
  }

  /** The buyer confirms what actually arrived, with evidence (PRD 6.3). */
  async confirmDelivery(
    org: ActingOrganization,
    userId: string,
    shipmentId: string,
    input: { recipientName: string; notes?: string; documentIds?: string[]; items: { orderLineId: string; deliveredQuantity: string }[] },
  ) {
    requireRole(org, CONSIGNEE_ROLES, 'confirm deliveries');
    const shipment = await this.owned(org, shipmentId, 'consignee');
    const byLine = new Map(shipment.items.map((i) => [i.orderLineId, i]));
    for (const d of input.items) {
      const item = byLine.get(d.orderLineId);
      if (!item) throw badRequest('unknown_line', `Order line ${d.orderLineId} is not on this shipment`);
      if (new Decimal(d.deliveredQuantity).greaterThan(item.quantity)) throw badRequest('over_delivery', 'Delivered quantity exceeds what was shipped');
    }
    for (const id of input.documentIds ?? []) {
      const doc = await this.documents.get(id);
      if (!doc || doc.ownerOrganizationId !== org.organization.id || doc.status !== 'available') {
        throw badRequest('invalid_evidence', `Document ${id} is not an available document of your organization`);
      }
    }

    const delivered = new Map(input.items.map((d) => [d.orderLineId, new Decimal(d.deliveredQuantity)]));
    const complete = shipment.items.every((i) => (delivered.get(i.orderLineId) ?? new Decimal(0)).equals(i.quantity));
    const to: ShipmentStatus = complete ? 'delivered' : 'partially_delivered';
    if (!canMove(shipment.status, to, 'consignee')) throw conflict('invalid_transition', `A ${shipment.status} shipment cannot be confirmed`);

    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const { count } = await tx.shipment.updateMany({ where: { id: shipmentId, status: shipment.status }, data: { status: to, deliveredAt: now } });
      if (count === 0) throw conflict('concurrent_change', 'The shipment changed; reload and try again');
      for (const item of shipment.items) {
        await tx.shipmentItem.update({ where: { id: item.id }, data: { deliveredQuantity: delivered.get(item.orderLineId) ?? new Decimal(0) } });
      }
      await tx.deliveryEvidence.create({
        data: { shipmentId, recipientName: input.recipientName, notes: input.notes, documentIds: input.documentIds ?? [], confirmedByUserId: userId },
      });
      await tx.trackingEvent.create({ data: { shipmentId, status: to, source: `user:${userId}`, occurredAt: now } });
      await tx.driverAssignment.updateMany({ where: { shipmentId, status: { in: ['assigned', 'accepted'] } }, data: { status: 'completed' } });
      for (const [orderId, items] of byOrder(shipment.items, shipment.orderId)) {
        await emitEvent(tx, SERVICE_NAME, 'DeliveryConfirmed', shipmentId, {
          shipmentId,
          orderId,
          shipperOrganizationId: shipment.shipperOrganizationId,
          consigneeOrganizationId: shipment.consigneeOrganizationId,
          complete: items.every((i) => (delivered.get(i.orderLineId) ?? new Decimal(0)).equals(i.quantity)),
          items: items.map((i) => ({ orderLineId: i.orderLineId, deliveredQuantity: (delivered.get(i.orderLineId) ?? new Decimal(0)).toString() })),
          deliveredAt: now.toISOString(),
        });
      }
      await this.announce(tx, shipment, to, null);
      return tx.shipment.findUniqueOrThrow({ where: { id: shipmentId }, include });
    });
  }

  async reportException(org: ActingOrganization, userId: string, shipmentId: string, type: string, description: string) {
    requireRole(org, READ_ROLES, 'report delivery problems');
    const shipment = await this.visible(org, shipmentId);
    return this.prisma.deliveryException.create({ data: { shipmentId: shipment.id, type, description, reportedByUserId: userId } });
  }

  async list(org: ActingOrganization, side: Side, query: PaginationQueryDto & { status?: string; orderId?: string }) {
    requireRole(org, READ_ROLES, 'view shipments');
    const where: Prisma.ShipmentWhereInput = {
      [sideField[side]]: org.organization.id,
      ...(side === 'carrier' ? { carrierStatus: { in: ['requested', 'accepted'] } } : {}),
      ...(query.status ? { status: query.status as ShipmentStatus } : {}),
      ...(query.orderId ? { orders: { some: { orderId: query.orderId } } } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.shipment.findMany({ where, include, orderBy: { createdAt: 'desc' }, ...skipTake(query) }),
      this.prisma.shipment.count({ where }),
    ]);
    return toPage(items, total, query);
  }

  get(org: ActingOrganization, shipmentId: string) {
    requireRole(org, READ_ROLES, 'view shipments');
    return this.visible(org, shipmentId);
  }

  async applyStatus(
    shipment: FullShipment,
    to: ShipmentStatus,
    source: string,
    occurredAt: Date,
    extra: { location?: string; note?: string; externalEventId?: string },
  ) {
    return this.prisma.$transaction(async (tx) => {
      if (shipment.status !== to) {
        const { count } = await tx.shipment.updateMany({ where: { id: shipment.id, status: shipment.status }, data: { status: to } });
        if (count === 0) throw conflict('concurrent_change', 'The shipment changed; reload and try again');
        await this.announce(tx, shipment, to, extra.note ?? null);
      }
      await tx.trackingEvent.create({ data: { shipmentId: shipment.id, status: to, source, occurredAt, ...extra } });
      return tx.shipment.findUniqueOrThrow({ where: { id: shipment.id }, include });
    });
  }

  /** Every status change is announced with the orders on board, so Commerce can react to failures. */
  announce(
    tx: Tx,
    shipment: { id: string; orderId: string; shipperOrganizationId: string; consigneeOrganizationId: string; carrierOrganizationId?: string | null; orders?: { orderId: string }[] },
    status: string,
    reason: string | null,
  ) {
    const orderIds = shipment.orders?.length ? shipment.orders.map((o) => o.orderId) : [shipment.orderId];
    return emitEvent(tx, SERVICE_NAME, 'ShipmentStatusChanged', shipment.id, {
      shipmentId: shipment.id,
      orderIds,
      shipperOrganizationId: shipment.shipperOrganizationId,
      consigneeOrganizationId: shipment.consigneeOrganizationId,
      carrierOrganizationId: shipment.carrierOrganizationId ?? null,
      status,
      reason,
    });
  }

  async owned(org: ActingOrganization, shipmentId: string, side: Side) {
    const shipment = await this.prisma.shipment.findFirst({
      where: { id: shipmentId, [sideField[side]]: org.organization.id, ...(side === 'carrier' ? { carrierStatus: { in: ['requested', 'accepted'] } } : {}) },
      include,
    });
    if (!shipment) throw notFound('Shipment');
    return shipment;
  }

  /** The shipper, the consignee, or the logistics provider asked to carry it; nobody else. */
  async visible(org: ActingOrganization, shipmentId: string) {
    const shipment = await this.prisma.shipment.findFirst({
      where: {
        id: shipmentId,
        OR: [
          { shipperOrganizationId: org.organization.id },
          { consigneeOrganizationId: org.organization.id },
          { carrierOrganizationId: org.organization.id, carrierStatus: { in: ['requested', 'accepted'] } },
        ],
      },
      include,
    });
    if (!shipment) throw notFound('Shipment');
    return shipment;
  }
}

export type { Actor };
