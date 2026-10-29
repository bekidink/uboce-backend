import { describe, expect, it } from 'vitest';

import { assertTransition, canTransition, cancellationFeePct, discountFor, withinReturnWindow } from './state-machine.js';

describe('order state machine', () => {
  it('only the supplier confirms', () => {
    expect(canTransition('pending_confirmation', 'confirmed', 'supplier')).toBe(true);
    expect(canTransition('pending_confirmation', 'confirmed', 'buyer')).toBe(false);
  });

  it('either side can cancel before confirmation; only the buyer after', () => {
    expect(canTransition('pending_confirmation', 'cancelled', 'buyer')).toBe(true);
    expect(canTransition('pending_confirmation', 'cancelled', 'supplier')).toBe(true);
    expect(canTransition('confirmed', 'cancelled', 'buyer')).toBe(true);
    expect(canTransition('confirmed', 'cancelled', 'supplier')).toBe(false);
  });

  it('cannot cancel once fulfilment has started', () => {
    expect(canTransition('partially_fulfilled', 'cancelled', 'buyer')).toBe(false);
    expect(canTransition('fulfilled', 'cancelled', 'buyer')).toBe(false);
  });

  it('terminal states stay terminal', () => {
    for (const to of ['confirmed', 'cancelled', 'closed'] as const) {
      expect(canTransition('cancelled', to, 'system')).toBe(false);
      expect(canTransition('closed', to, 'system')).toBe(false);
    }
  });

  it('assertTransition explains what was refused', () => {
    expect(() => assertTransition('cancelled', 'confirmed', 'supplier')).toThrow('cannot move an order from cancelled to confirmed');
  });
});

describe('pickup and failed delivery', () => {
  it('pickup orders become ready, then collected or uncollected', () => {
    expect(canTransition('confirmed', 'ready_for_pickup', 'supplier')).toBe(true);
    expect(canTransition('ready_for_pickup', 'fulfilled', 'supplier')).toBe(true);
    expect(canTransition('ready_for_pickup', 'uncollected', 'supplier')).toBe(true);
    expect(canTransition('ready_for_pickup', 'uncollected', 'buyer')).toBe(false);
  });
  it('failed deliveries are retried or cancelled', () => {
    expect(canTransition('confirmed', 'delivery_failed', 'system')).toBe(true);
    expect(canTransition('delivery_failed', 'confirmed', 'supplier')).toBe(true);
    expect(canTransition('delivery_failed', 'cancelled', 'buyer')).toBe(true);
  });
});

describe('policy arithmetic', () => {
  const policy = { id: 'p', version: 1, name: 'Std', freeCancellationHours: 24, cancellationFeePct: '10', noShowFeePct: '5', returnWindowDays: 7, restockingFeePct: '15', pickupHoldHours: 72, terms: null };
  const confirmed = new Date('2026-10-01T10:00:00Z');
  it('cancellation is free inside the window and charged after', () => {
    expect(cancellationFeePct(policy, 'confirmed', confirmed, new Date('2026-10-02T09:00:00Z'))).toBe(0);
    expect(cancellationFeePct(policy, 'confirmed', confirmed, new Date('2026-10-02T11:00:00Z'))).toBe(10);
    expect(cancellationFeePct(policy, 'pending_confirmation', null)).toBe(0);
    expect(cancellationFeePct(null, 'confirmed', confirmed)).toBe(0);
  });
  it('returns only inside the window', () => {
    expect(withinReturnWindow(policy, confirmed, new Date('2026-10-05T00:00:00Z'))).toBe(true);
    expect(withinReturnWindow(policy, confirmed, new Date('2026-10-09T00:00:00Z'))).toBe(false);
    expect(withinReturnWindow({ ...policy, returnWindowDays: 0 }, confirmed, confirmed)).toBe(false);
  });
  it('discounts are capped and never exceed the subtotal', () => {
    expect(discountFor({ kind: 'percent', value: 10, maxDiscount: null }, 1000)).toBe(100);
    expect(discountFor({ kind: 'percent', value: 10, maxDiscount: 50 }, 1000)).toBe(50);
    expect(discountFor({ kind: 'fixed', value: 300, maxDiscount: null }, 200)).toBe(200);
  });
});
