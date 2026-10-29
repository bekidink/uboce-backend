import { Prisma } from '../generated/prisma/client.js';

// Stock rules (PRD 5.9), free of I/O so they can be tested directly.

const { Decimal } = Prisma;
type Decimal = Prisma.Decimal;

export const INCREASING = new Set(['receipt', 'transfer_in', 'production_output']);
export const DECREASING = new Set(['issue', 'transfer_out', 'production_issue']);

export interface BalanceState {
  onHand: Decimal;
  reserved: Decimal;
  /** Damaged + quarantined: on hand but not sellable (PRD addendum 2.1). */
  held?: Decimal;
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
  const held = balance.held ?? new Decimal(0);
  if (reserved.isNegative()) return { error: 'Cannot release more than is reserved' };
  if (onHand.isNegative()) return { error: 'Not enough stock on hand' };
  // Free stock may not go negative: reservations and damaged/quarantined stock must stay covered.
  if (onHand.lessThan(reserved.plus(held))) return { error: held.greaterThan(0) ? 'Not enough sellable stock (some is damaged or quarantined)' : 'Not enough unreserved stock' };
  return { next: { onHand, reserved } };
}

/**
 * Moves stock between states. Out of "available" needs free (unreserved, sellable) stock;
 * out of damaged/quarantined needs that much in the state.
 */
export function changeState(
  balance: { onHand: Decimal; reserved: Decimal; damaged: Decimal; quarantined: Decimal },
  from: 'available' | 'damaged' | 'quarantined',
  to: 'available' | 'damaged' | 'quarantined',
  quantity: Decimal,
): { next: { damaged: Decimal; quarantined: Decimal } } | { error: string } {
  if (from === to) return { error: 'Pick two different states' };
  if (!quantity.greaterThan(0)) return { error: 'Quantity must be more than 0' };
  const next = { damaged: balance.damaged, quarantined: balance.quarantined };
  if (from === 'available') {
    const free = balance.onHand.minus(balance.reserved).minus(balance.damaged).minus(balance.quarantined);
    if (quantity.greaterThan(free)) return { error: `Only ${free.toString()} is available` };
  } else {
    if (quantity.greaterThan(next[from])) return { error: `Only ${next[from].toString()} is ${from}` };
    next[from] = next[from].minus(quantity);
  }
  if (to !== 'available') next[to] = next[to].plus(quantity);
  return { next };
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
