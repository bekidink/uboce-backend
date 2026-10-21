import { describe, expect, it } from 'vitest';

import { assertTransition, canTransition } from './state-machine.js';

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
