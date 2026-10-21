import { Prisma } from '../generated/prisma/client.js';

// Shipment rules (PRD 5.13) without I/O.

const { Decimal } = Prisma;

/** Who may move a shipment to which status. */
const TRANSITIONS: Record<string, { to: string; by: ('shipper' | 'consignee' | 'carrier')[] }[]> = {
  created: [
    { to: 'dispatched', by: ['shipper'] },
    { to: 'cancelled', by: ['shipper'] },
  ],
  dispatched: [
    { to: 'in_transit', by: ['shipper', 'carrier'] },
    { to: 'delivered', by: ['consignee'] },
    { to: 'partially_delivered', by: ['consignee'] },
    { to: 'failed', by: ['shipper', 'carrier'] },
  ],
  in_transit: [
    { to: 'in_transit', by: ['shipper', 'carrier'] },
    { to: 'delivered', by: ['consignee'] },
    { to: 'partially_delivered', by: ['consignee'] },
    { to: 'failed', by: ['shipper', 'carrier'] },
    { to: 'returned', by: ['shipper', 'carrier'] },
  ],
  failed: [{ to: 'returned', by: ['shipper', 'carrier'] }],
  delivered: [],
  partially_delivered: [],
  returned: [],
  cancelled: [],
};

export const canMove = (from: string, to: string, by: 'shipper' | 'consignee' | 'carrier') =>
  (TRANSITIONS[from] ?? []).some((t) => t.to === to && t.by.includes(by));

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
