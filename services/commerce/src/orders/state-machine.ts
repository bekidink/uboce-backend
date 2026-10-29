// Order lifecycle (PRD 5.8, addendum 2.6). Every status change goes through `assertTransition`.

export type OrderStatus =
  | 'pending_confirmation'
  | 'confirmed'
  | 'ready_for_pickup'
  | 'uncollected'
  | 'delivery_failed'
  | 'partially_fulfilled'
  | 'fulfilled'
  | 'closed'
  | 'cancelled'
  | 'exception';

export type OrderParty = 'buyer' | 'supplier';

interface Transition {
  to: OrderStatus;
  /** Who may trigger it. Fulfillment moves come from Stage 3 services (system). */
  by: (OrderParty | 'system')[];
}

const TRANSITIONS: Record<OrderStatus, Transition[]> = {
  pending_confirmation: [
    { to: 'confirmed', by: ['supplier'] },
    // The buyer withdraws, or the supplier declines.
    { to: 'cancelled', by: ['buyer', 'supplier'] },
    { to: 'exception', by: ['system'] },
  ],
  confirmed: [
    { to: 'partially_fulfilled', by: ['system'] },
    { to: 'fulfilled', by: ['system'] },
    // Pickup orders: the supplier has the goods ready at the collection point.
    { to: 'ready_for_pickup', by: ['supplier'] },
    { to: 'delivery_failed', by: ['supplier', 'system'] },
    // Before dispatch only; after that a corrective workflow is needed (PRD 8.5).
    { to: 'cancelled', by: ['buyer'] },
    { to: 'exception', by: ['system'] },
  ],
  ready_for_pickup: [
    // Collected: the supplier hands the goods over.
    { to: 'fulfilled', by: ['supplier'] },
    { to: 'uncollected', by: ['supplier'] },
    { to: 'cancelled', by: ['buyer'] },
  ],
  uncollected: [
    // A new pickup appointment, or give up.
    { to: 'ready_for_pickup', by: ['supplier'] },
    { to: 'cancelled', by: ['buyer', 'supplier'] },
  ],
  delivery_failed: [
    // Retry the delivery, or cancel.
    { to: 'confirmed', by: ['supplier', 'system'] },
    { to: 'cancelled', by: ['buyer', 'supplier'] },
    { to: 'partially_fulfilled', by: ['system'] },
    { to: 'fulfilled', by: ['system'] },
  ],
  partially_fulfilled: [
    { to: 'fulfilled', by: ['system'] },
    { to: 'delivery_failed', by: ['supplier', 'system'] },
    { to: 'exception', by: ['system'] },
  ],
  fulfilled: [{ to: 'closed', by: ['buyer', 'system'] }],
  exception: [
    { to: 'confirmed', by: ['system'] },
    { to: 'cancelled', by: ['buyer', 'system'] },
  ],
  closed: [],
  cancelled: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus, by: OrderParty | 'system') {
  return TRANSITIONS[from].some((t) => t.to === to && t.by.includes(by));
}

export class InvalidTransitionError extends Error {
  constructor(from: OrderStatus, to: OrderStatus, by: string) {
    super(`The ${by} cannot move an order from ${from} to ${to}`);
  }
}

export function assertTransition(from: OrderStatus, to: OrderStatus, by: OrderParty | 'system') {
  if (!canTransition(from, to, by)) throw new InvalidTransitionError(from, to, by);
}

// ---- Policy arithmetic (pure) ------------------------------------------------------------

export interface PolicySnapshot {
  id: string;
  version: number;
  name: string;
  freeCancellationHours: number;
  cancellationFeePct: string;
  noShowFeePct: string;
  returnWindowDays: number;
  restockingFeePct: string;
  pickupHoldHours: number;
  terms: string | null;
}

/** Fee for a buyer cancelling: free until confirmation + the free window, then the policy percentage. */
export function cancellationFeePct(policy: PolicySnapshot | null, status: OrderStatus, confirmedAt: Date | null, now = new Date()): number {
  if (!policy || status === 'pending_confirmation' || !confirmedAt) return 0;
  const freeUntil = confirmedAt.getTime() + policy.freeCancellationHours * 3_600_000;
  return now.getTime() <= freeUntil ? 0 : Number(policy.cancellationFeePct);
}

/** Whether a return may still be requested. */
export function withinReturnWindow(policy: PolicySnapshot | null, fulfilledAt: Date | null, now = new Date()) {
  if (!policy || policy.returnWindowDays <= 0 || !fulfilledAt) return false;
  return now.getTime() <= fulfilledAt.getTime() + policy.returnWindowDays * 86_400_000;
}

/** Discount for a promotion on a subtotal (never more than the subtotal). */
export function discountFor(p: { kind: 'percent' | 'fixed'; value: number; maxDiscount: number | null }, subtotal: number) {
  const raw = p.kind === 'percent' ? (subtotal * p.value) / 100 : p.value;
  const capped = p.maxDiscount !== null ? Math.min(raw, p.maxDiscount) : raw;
  return Math.max(0, Math.min(subtotal, Math.round(capped * 100) / 100));
}
