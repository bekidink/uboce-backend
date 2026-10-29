import { Prisma } from '../generated/prisma/client.js';

// Shipment rules (PRD 5.13, addendum 2.8) without I/O.

const { Decimal } = Prisma;

export type Actor = 'shipper' | 'consignee' | 'carrier' | 'driver';

/** Who may move a shipment to which status. "created" is the planned state. */
const TRANSITIONS: Record<string, { to: string; by: Actor[] }[]> = {
  created: [
    { to: 'assigned', by: ['shipper'] },
    { to: 'ready_for_pickup', by: ['shipper'] },
    { to: 'dispatched', by: ['shipper'] },
    { to: 'cancelled', by: ['shipper'] },
  ],
  assigned: [
    { to: 'ready_for_pickup', by: ['shipper'] },
    { to: 'dispatched', by: ['shipper'] },
    { to: 'created', by: ['shipper'] },
    { to: 'cancelled', by: ['shipper'] },
  ],
  ready_for_pickup: [
    { to: 'dispatched', by: ['shipper'] },
    { to: 'cancelled', by: ['shipper'] },
  ],
  dispatched: [
    { to: 'picked_up', by: ['shipper', 'carrier', 'driver'] },
    { to: 'in_transit', by: ['shipper', 'carrier', 'driver'] },
    { to: 'delayed', by: ['shipper', 'carrier', 'driver'] },
    { to: 'delivered', by: ['consignee'] },
    { to: 'partially_delivered', by: ['consignee'] },
    { to: 'failed', by: ['shipper', 'carrier', 'driver'] },
  ],
  picked_up: [
    { to: 'in_transit', by: ['shipper', 'carrier', 'driver'] },
    { to: 'delayed', by: ['shipper', 'carrier', 'driver'] },
    { to: 'delivered', by: ['consignee'] },
    { to: 'partially_delivered', by: ['consignee'] },
    { to: 'failed', by: ['shipper', 'carrier', 'driver'] },
  ],
  in_transit: [
    { to: 'in_transit', by: ['shipper', 'carrier', 'driver'] },
    { to: 'delayed', by: ['shipper', 'carrier', 'driver'] },
    { to: 'delivered', by: ['consignee'] },
    { to: 'partially_delivered', by: ['consignee'] },
    { to: 'failed', by: ['shipper', 'carrier', 'driver'] },
    { to: 'returned', by: ['shipper', 'carrier', 'driver'] },
  ],
  delayed: [
    { to: 'in_transit', by: ['shipper', 'carrier', 'driver'] },
    { to: 'delivered', by: ['consignee'] },
    { to: 'partially_delivered', by: ['consignee'] },
    { to: 'failed', by: ['shipper', 'carrier', 'driver'] },
    { to: 'returned', by: ['shipper', 'carrier', 'driver'] },
  ],
  failed: [{ to: 'returned', by: ['shipper', 'carrier', 'driver'] }],
  delivered: [],
  partially_delivered: [],
  returned: [],
  cancelled: [],
};

/** Statuses from which a shipment has left the origin (stock has been issued). */
export const AFTER_DISPATCH = ['dispatched', 'picked_up', 'in_transit', 'delayed'];

export const canMove = (from: string, to: string, by: Actor) => (TRANSITIONS[from] ?? []).some((t) => t.to === to && t.by.includes(by));

/**
 * How much of each order line is still unshipped, given earlier shipments
 * that weren't cancelled. A new shipment may not exceed it.
 */
export function remainingToShip(
  orderLines: { id: string; quantity: string }[],
  earlier: { orderLineId: string; quantity: Prisma.Decimal }[],
): Map<string, Prisma.Decimal> {
  const remaining = new Map(orderLines.map((l) => [l.id, new Decimal(l.quantity)]));
  for (const e of earlier) {
    const left = remaining.get(e.orderLineId);
    if (left) remaining.set(e.orderLineId, left.minus(e.quantity));
  }
  return remaining;
}

/** Groups shipment items by the order they belong to (consolidated shipments carry several). */
export function byOrder<T extends { orderId: string | null }>(items: T[], fallbackOrderId: string) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = item.orderId ?? fallbackOrderId;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return groups;
}
