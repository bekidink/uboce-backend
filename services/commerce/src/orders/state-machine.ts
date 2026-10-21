// Order lifecycle (PRD 5.8). Every status change goes through `assertTransition`.

export type OrderStatus =
  | 'pending_confirmation'
  | 'confirmed'
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
    // Before dispatch only; after that a corrective workflow is needed (PRD 8.5).
    { to: 'cancelled', by: ['buyer'] },
    { to: 'exception', by: ['system'] },
  ],
  partially_fulfilled: [
    { to: 'fulfilled', by: ['system'] },
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
