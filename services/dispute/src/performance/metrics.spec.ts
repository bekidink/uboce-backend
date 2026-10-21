import { describe, expect, it } from 'vitest';

import { computeMetrics } from './metrics.js';

const at = (h: number) => new Date(Date.UTC(2026, 0, 1) + h * 3_600_000);

describe('supplier metrics', () => {
  it('computes rates and median confirmation time from facts', () => {
    const m = computeMetrics([
      { kind: 'order_created', reference: 'o1', occurredAt: at(0) },
      { kind: 'order_created', reference: 'o2', occurredAt: at(0) },
      { kind: 'order_created', reference: 'o3', occurredAt: at(0) },
      { kind: 'order_confirmed', reference: 'o1', occurredAt: at(2) },
      { kind: 'order_confirmed', reference: 'o2', occurredAt: at(10) },
      { kind: 'order_cancelled', reference: 'o3', occurredAt: at(1) },
      { kind: 'delivery_complete', reference: 's1', occurredAt: at(50) },
      { kind: 'delivery_partial', reference: 's2', occurredAt: at(60) },
      { kind: 'dispute_opened', reference: 'd1', occurredAt: at(70) },
    ]);
    expect(m).toMatchObject({
      ordersReceived: 3,
      confirmationRatePct: 66.7,
      medianConfirmationHours: 2,
      cancellationRatePct: 33.3,
      completeDeliveryRatePct: 50,
      disputesAgainst: 1,
      disputesLost: 0,
    });
  });

  it('reports nothing rather than zero when there is no data', () => {
    expect(computeMetrics([])).toMatchObject({ confirmationRatePct: null, medianConfirmationHours: null });
  });
});
