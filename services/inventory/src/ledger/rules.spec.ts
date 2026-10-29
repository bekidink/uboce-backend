import { describe, expect, it } from 'vitest';

import { Prisma } from '../generated/prisma/client.js';
import { allocate, applyMovement, changeState } from './rules.js';

const d = (v: string | number) => new Prisma.Decimal(v);
const bal = (onHand: number, reserved = 0) => ({ onHand: d(onHand), reserved: d(reserved) });

describe('applyMovement', () => {
  it('adds and removes stock', () => {
    expect(applyMovement(bal(0), 'receipt', d(10))).toEqual({ next: bal(10) });
    expect(applyMovement(bal(10), 'issue', d(-4))).toEqual({ next: bal(6) });
  });

  it('enforces the direction of each movement type', () => {
    expect(applyMovement(bal(10), 'receipt', d(-1))).toHaveProperty('error');
    expect(applyMovement(bal(10), 'issue', d(1))).toHaveProperty('error');
  });

  it('protects other reservations from free-stock issues', () => {
    // 10 on hand, 8 reserved by orders: only 2 are free.
    expect(applyMovement(bal(10, 8), 'issue', d(-3))).toEqual({ error: 'Not enough unreserved stock' });
    expect(applyMovement(bal(10, 8), 'issue', d(-2))).toEqual({ next: bal(8, 8) });
  });

  it('lets a reservation holder draw down its own hold', () => {
    expect(applyMovement(bal(10, 8), 'issue', d(-8), d(8))).toEqual({ next: bal(2, 0) });
    expect(applyMovement(bal(10, 2), 'issue', d(-3), d(3))).toEqual({ error: 'Cannot release more than is reserved' });
  });

  it('never adjusts below what is reserved', () => {
    expect(applyMovement(bal(10, 6), 'adjustment', d(-5))).toHaveProperty('error');
    expect(applyMovement(bal(10, 6), 'adjustment', d(-4))).toEqual({ next: bal(6, 6) });
  });
});

describe('allocate', () => {
  it('uses the fewest warehouses, biggest first', () => {
    const picks = allocate(d(12), [
      { warehouseId: 'a', available: d(5) },
      { warehouseId: 'b', available: d(10) },
      { warehouseId: 'c', available: d(0) },
    ]);
    expect(picks?.map((p) => [p.warehouseId, p.quantity.toString()])).toEqual([
      ['b', '10'],
      ['a', '2'],
    ]);
  });

  it('is all-or-nothing', () => {
    expect(allocate(d(16), [{ warehouseId: 'a', available: d(15) }])).toBeNull();
  });
});

describe('zero quantities (Decimal treats 0 as "positive")', () => {
  it('never allocates from an empty warehouse', () => {
    const picks = allocate(d(5), [
      { warehouseId: 'empty', available: d(0) },
      { warehouseId: 'full', available: d(5) },
    ]);
    expect(picks?.map((p) => p.warehouseId)).toEqual(['full']);
  });
});

describe('stock states', () => {
  const b = (onHand: number, reserved: number, damaged = 0, quarantined = 0) => ({ onHand: d(onHand), reserved: d(reserved), damaged: d(damaged), quarantined: d(quarantined) });
  it('damaged and quarantined stock is not sellable', () => {
    expect(applyMovement({ onHand: d(10), reserved: d(0), held: d(6) }, 'issue', d(-5))).toHaveProperty('error');
    expect(applyMovement({ onHand: d(10), reserved: d(0), held: d(6) }, 'issue', d(-4))).toEqual({ next: { onHand: d(6), reserved: d(0) } });
  });
  it('moves stock between states within what is free', () => {
    expect(changeState(b(10, 4), 'available', 'damaged', d(6))).toEqual({ next: { damaged: d(6), quarantined: d(0) } });
    expect(changeState(b(10, 4), 'available', 'damaged', d(7))).toHaveProperty('error');
    expect(changeState(b(10, 0, 3), 'damaged', 'quarantined', d(2))).toEqual({ next: { damaged: d(1), quarantined: d(2) } });
    expect(changeState(b(10, 0, 0, 2), 'quarantined', 'available', d(3))).toHaveProperty('error');
  });
});
