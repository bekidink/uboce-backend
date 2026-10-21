// Supplier performance (PRD 5.18), computed from stored facts with a versioned
// formula, so anyone can reproduce a score from the same facts.

export const FORMULA_VERSION = 'perf-2026.1';

export interface Fact {
  kind: string;
  reference: string;
  occurredAt: Date;
}

const ratio = (num: number, den: number) => (den === 0 ? null : Math.round((num / den) * 1000) / 10);

export function computeMetrics(facts: Fact[]) {
  const count = (kind: string) => facts.filter((f) => f.kind === kind).length;
  const created = new Map(facts.filter((f) => f.kind === 'order_created').map((f) => [f.reference, f.occurredAt]));

  const confirmationHours = facts
    .filter((f) => f.kind === 'order_confirmed' && created.has(f.reference))
    .map((f) => (f.occurredAt.getTime() - created.get(f.reference)!.getTime()) / 3_600_000);
  const sorted = [...confirmationHours].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)]! : null;

  const ordersReceived = count('order_created');
  const deliveries = count('delivery_complete') + count('delivery_partial');

  return {
    formulaVersion: FORMULA_VERSION,
    ordersReceived,
    /** % of received orders the supplier confirmed. */
    confirmationRatePct: ratio(count('order_confirmed'), ordersReceived),
    /** Median hours from order to confirmation. */
    medianConfirmationHours: median === null ? null : Math.round(median * 10) / 10,
    /** % of orders the supplier cancelled or declined. */
    cancellationRatePct: ratio(count('order_cancelled'), ordersReceived),
    /** % of deliveries that arrived complete. */
    completeDeliveryRatePct: ratio(count('delivery_complete'), deliveries),
    disputesAgainst: count('dispute_opened'),
    /** Disputes resolved in the opener's favour, i.e. against this supplier. Allegations alone don't count. */
    disputesLost: count('dispute_lost'),
  };
}
