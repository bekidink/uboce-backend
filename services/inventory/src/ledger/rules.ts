import { Prisma } from '../generated/prisma/client.js';

// Stock rules (PRD 5.9), free of I/O so they can be tested directly.

const { Decimal } = Prisma;
type Decimal = Prisma.Decimal;

export const INCREASING = new Set(['receipt', 'transfer_in', 'production_output']);
export const DECREASING = new Set(['issue', 'transfer_out', 'production_issue']);

export interface BalanceState {
  onHand: Decimal;
  reserved: Decimal;
}

/**
 * Applies one movement to a balance, or explains why it isn't allowed.
 * `fromReserved` is how much of a decrease is drawn from this caller's own
 * reservation (it releases that hold rather than competing with other orders).
 */
export function applyMovement(
  balance: BalanceState,
  type: string,
  quantity: Decimal,
  fromReserved: Decimal = new Decimal(0),
): { next: BalanceState } | { error: string } {
  if (quantity.isZero()) return { error: 'Quantity cannot be zero' };
  if (INCREASING.has(type) && quantity.isNegative()) return { error: `${type} must add stock` };
  if (DECREASING.has(type) && quantity.greaterThan(0)) return { error: `${type} must remove stock` };

  const onHand = balance.onHand.plus(quantity);
  const reserved = balance.reserved.minus(fromReserved);
  if (reserved.isNegative()) return { error: 'Cannot release more than is reserved' };
  if (onHand.isNegative()) return { error: 'Not enough stock on hand' };
  // Free stock may not go negative: other orders' reservations must stay covered.
  if (onHand.lessThan(reserved)) return { error: 'Not enough unreserved stock' };
  return { next: { onHand, reserved } };
}

export interface Candidate {
  warehouseId: string;
  available: Decimal;
}

/**
 * Splits a requested quantity across warehouses, largest availability first,
 * so an order is served from as few warehouses as possible. Returns null when
 * the total available is insufficient (all-or-nothing reservation).
 */
export function allocate(requested: Decimal, candidates: Candidate[]): { warehouseId: string; quantity: Decimal }[] | null {
  const sorted = [...candidates].filter((c) => c.available.greaterThan(0)).sort((a, b) => b.available.comparedTo(a.available));
  const picks: { warehouseId: string; quantity: Decimal }[] = [];
  let remaining = requested;
  for (const c of sorted) {
    if (remaining.isZero()) break;
    const take = Decimal.min(remaining, c.available);
    picks.push({ warehouseId: c.warehouseId, quantity: take });
    remaining = remaining.minus(take);
  }
  return remaining.isZero() ? picks : null;
}
