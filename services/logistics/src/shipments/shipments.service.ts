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
  type PaginationQueryDto,
  requireRole,
  skipTake,
  toPage,
  WarehousesClient,
} from '@uboce/common';
import type { CarrierTrackingEvent } from '@uboce/contracts';

import { SERVICE_NAME } from '../config.js';
import { Prisma } from '../generated/prisma/client.js';
import type { ShipmentStatus } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma.service.js';
import { canMove, remainingToShip } from './rules.js';

const { Decimal } = Prisma;
const SHIPPER_ROLES = ['owner', 'admin', 'logistics_operator', 'warehouse_operator', 'sales_representative'];
const CONSIGNEE_ROLES = ['owner', 'admin', 'logistics_operator', 'warehouse_operator', 'procurement_officer'];
const include = {
  items: { orderBy: { lineNumber: 'asc' } },
  tracking: { orderBy: { occurredAt: 'asc' } },
  evidence: true,
  exceptions: true,
} as const;

type Side = 'shipper' | 'consignee';

export interface CreateShipmentInput {
  orderId: string;
  originWarehouseId?: string;
  destination?: string;
  carrierName?: string;
  trackingNumber?: string;
  expectedDeliveryAt?: string;
  items: { orderLineId: string; quantity: string }[];
}

@Injectable()
export class ShipmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commerce: CommerceClient,
    private readonly inventory: InventoryClient,
    private readonly warehouses: WarehousesClient,
    private readonly documents: DocumentsClient,
  ) {}

  /** The supplier plans a shipment for a confirmed order; quantities can't exceed what's still unshipped. */
  async create(org: ActingOrganization, userId: string, input: CreateShipmentInput) {
    requireRole(org, SHIPPER_ROLES, 'create shipments');
    const order = await this.commerce.getOrder(input.orderId);
    if (!order || order.supplierOrganizationId !== org.organization.id) throw notFound('Order');
    if (!['confirmed', 'partially_fulfilled'].includes(order.status)) {
      throw conflict('order_not_shippable', `Orders that are ${order.status} cannot be shipped`);
    }
    if (input.originWarehouseId) {
      const warehouse = await this.warehouses.get(input.originWarehouseId);
      if (!warehouse || warehouse.organizationId !== org.organization.id) throw badRequest('unknown_warehouse', 'Warehouse not found in your organization');
    }

    const earlier = await this.prisma.shipmentItem.findMany({
      where: { shipment: { orderId: order.id, status: { not: 'cancelled' } } },
      select: { orderLineId: true, quantity: true },
    });
    const remaining = remainingToShip(order.lines, earlier);
    for (const item of input.items) {
      const left = remaining.get(item.orderLineId);
      if (!left) throw badRequest('unknown_line', `Order line ${item.orderLineId} is not on this order`);
      if (new Decimal(item.quantity).greaterThan(left)) {
        throw badRequest('over_shipment', `Only ${left.toString()} left to ship on line ${item.orderLineId}`);
      }
      remaining.set(item.orderLineId, left.minus(item.quantity));
    }

    const lines = new Map(order.lines.map((l) => [l.id, l]));
    try {
      return await this.prisma.shipment.create({
        data: {
          orderId: order.id,
          orderNumber: order.number,
          shipperOrganizationId: order.supplierOrganizationId,
          consigneeOrganizationId: order.buyerOrganizationId,
          originWarehouseId: input.originWarehouseId,
          destination: input.destination ?? order.deliveryLocation ?? 'As agreed on the order',
          carrierName: input.carrierName,
          trackingNumber: input.trackingNumber,
          expectedDeliveryAt: input.expectedDeliveryAt ? new Date(input.expectedDeliveryAt) : null,
          createdByUserId: userId,
          items: {
            create: input.items.map((item, i) => {
              const line = lines.get(item.orderLineId)!;
              return { lineNumber: i + 1, orderLineId: item.orderLineId, itemId: line.productId, description: line.description, quantity: item.quantity };
            }),
          },
        },
        include,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw conflict('tracking_number_taken', 'That tracking number is already used');
      }
      throw error;
    }
  }

  /**
   * Dispatch issues stock from the origin warehouse, drawing down the order's
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
            reservation: { referenceType: 'order', referenceId: shipment.orderId },
          });
        } catch (error) {
          const body = (error as { body?: { error?: { code?: string; message?: string } } }).body;
          throw new AppError(
            HttpStatus.CONFLICT,
            body?.error?.code ?? 'stock_issue_failed',
            `Line ${item.lineNumber}: ${body?.error?.message ?? 'stock could not be issued'}`,
          );
        }
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.shipment.updateMany({ where: { id: shipmentId, status: 'created' }, data: { status: 'dispatched', dispatchedAt: new Date() } });
      if (count === 0) throw conflict('concurrent_change', 'The shipment changed; reload and try again');
      await tx.trackingEvent.create({ data: { shipmentId, status: 'dispatched', source: `user:${userId}`, occurredAt: new Date() } });
      await emitEvent(tx, SERVICE_NAME, 'ShipmentDispatched', shipmentId, {
        shipmentId,
        orderId: shipment.orderId,
        shipperOrganizationId: shipment.shipperOrganizationId,
        consigneeOrganizationId: shipment.consigneeOrganizationId,
        originWarehouseId: shipment.originWarehouseId,
        items: shipment.items.map((i) => ({ orderLineId: i.orderLineId, itemId: i.itemId, quantity: i.quantity.toString() })),
        dispatchedAt: new Date().toISOString(),
      });
      return tx.shipment.findUniqueOrThrow({ where: { id: shipmentId }, include });
    });
  }

  /** In-transit updates, failures and returns from the shipper. */
  async track(org: ActingOrganization, userId: string, shipmentId: string, status: ShipmentStatus, location?: string, note?: string) {
    requireRole(org, SHIPPER_ROLES, 'update shipments');
    const shipment = await this.owned(org, shipmentId, 'shipper');
    if (!canMove(shipment.status, status, 'shipper')) throw conflict('invalid_transition', `Cannot move a ${shipment.status} shipment to ${status}`);
    return this.applyStatus(shipmentId, shipment.status, status, `user:${userId}`, new Date(), { location, note });
  }

  /** Carrier callbacks, verified by the Integration service. Duplicates are ignored. */
  async carrierEvent(event: CarrierTrackingEvent) {
    const shipment = await this.prisma.shipment.findUnique({ where: { trackingNumber: event.trackingNumber } });
    if (!shipment) throw notFound('Shipment');
    const seen = await this.prisma.trackingEvent.findUnique({ where: { externalEventId: `${event.provider}:${event.externalEventId}` } });
    if (seen) return { applied: false };
    // Carriers can report delivery, but only the consignee's confirmation completes it.
    const status = event.status === 'delivered' ? 'in_transit' : event.status;
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
    await this.applyStatus(shipment.id, shipment.status, status, `carrier:${event.provider}`, new Date(event.occurredAt), {
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
      const { count } = await tx.shipment.updateMany({ where: { id: shipmentId, status: shipment.status }, data: { status: to, deliveredAt: new Date() } });
      if (count === 0) throw conflict('concurrent_change', 'The shipment changed; reload and try again');
      for (const item of shipment.items) {
        await tx.shipmentItem.update({ where: { id: item.id }, data: { deliveredQuantity: delivered.get(item.orderLineId) ?? new Decimal(0) } });
      }
      await tx.deliveryEvidence.create({
        data: { shipmentId, recipientName: input.recipientName, notes: input.notes, documentIds: input.documentIds ?? [], confirmedByUserId: userId },
      });
      await tx.trackingEvent.create({ data: { shipmentId, status: to, source: `user:${userId}`, occurredAt: new Date() } });
      await emitEvent(tx, SERVICE_NAME, 'DeliveryConfirmed', shipmentId, {
        shipmentId,
        orderId: shipment.orderId,
        shipperOrganizationId: shipment.shipperOrganizationId,
        consigneeOrganizationId: shipment.consigneeOrganizationId,
        complete,
        items: shipment.items.map((i) => ({ orderLineId: i.orderLineId, deliveredQuantity: (delivered.get(i.orderLineId) ?? new Decimal(0)).toString() })),
        deliveredAt: new Date().toISOString(),
      });
      return tx.shipment.findUniqueOrThrow({ where: { id: shipmentId }, include });
    });
  }

  async reportException(org: ActingOrganization, userId: string, shipmentId: string, type: string, description: string) {
    const shipment = await this.visible(org, shipmentId);
    return this.prisma.deliveryException.create({ data: { shipmentId: shipment.id, type, description, reportedByUserId: userId } });
  }

  async list(org: ActingOrganization, side: Side, query: PaginationQueryDto) {
    const where = side === 'shipper' ? { shipperOrganizationId: org.organization.id } : { consigneeOrganizationId: org.organization.id };
    const [items, total] = await Promise.all([
      this.prisma.shipment.findMany({ where, include, orderBy: { createdAt: 'desc' }, ...skipTake(query) }),
      this.prisma.shipment.count({ where }),
    ]);
    return toPage(items, total, query);
  }

  get(org: ActingOrganization, shipmentId: string) {
    return this.visible(org, shipmentId);
  }

  private async applyStatus(
    shipmentId: string,
    from: ShipmentStatus,
    to: ShipmentStatus,
    source: string,
    occurredAt: Date,
    extra: { location?: string; note?: string; externalEventId?: string },
  ) {
    return this.prisma.$transaction(async (tx) => {
      if (from !== to) {
        const { count } = await tx.shipment.updateMany({ where: { id: shipmentId, status: from }, data: { status: to } });
        if (count === 0) throw conflict('concurrent_change', 'The shipment changed; reload and try again');
      }
      await tx.trackingEvent.create({ data: { shipmentId, status: to, source, occurredAt, ...extra } });
      return tx.shipment.findUniqueOrThrow({ where: { id: shipmentId }, include });
    });
  }

  private async owned(org: ActingOrganization, shipmentId: string, side: Side) {
    const shipment = await this.prisma.shipment.findFirst({
      where: { id: shipmentId, [side === 'shipper' ? 'shipperOrganizationId' : 'consigneeOrganizationId']: org.organization.id },
      include,
    });
    if (!shipment) throw notFound('Shipment');
    return shipment;
  }

  /** Either party to the shipment; nobody else. */
  private async visible(org: ActingOrganization, shipmentId: string) {
    const shipment = await this.prisma.shipment.findFirst({
      where: { id: shipmentId, OR: [{ shipperOrganizationId: org.organization.id }, { consigneeOrganizationId: org.organization.id }] },
      include,
    });
    if (!shipment) throw notFound('Shipment');
    return shipment;
  }
}
