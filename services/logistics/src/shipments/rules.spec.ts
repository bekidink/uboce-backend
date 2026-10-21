import { describe, expect, it } from 'vitest';

import { Prisma } from '../generated/prisma/client.js';
import { canMove, remainingToShip } from './rules.js';

describe('shipment transitions', () => {
  it('only the consignee confirms delivery', () => {
    expect(canMove('in_transit', 'delivered', 'consignee')).toBe(true);
    expect(canMove('in_transit', 'delivered', 'shipper')).toBe(false);
    expect(canMove('in_transit', 'delivered', 'carrier')).toBe(false);
  });

  it('cannot skip dispatch or reopen a finished shipment', () => {
    expect(canMove('created', 'delivered', 'consignee')).toBe(false);
    expect(canMove('delivered', 'in_transit', 'carrier')).toBe(false);
  });
});

describe('remainingToShip', () => {
  it('subtracts earlier shipments per order line', () => {
    const left = remainingToShip(
      [
        { id: 'a', quantity: '50' },
        { id: 'b', quantity: '100' },
      ],
      [{ orderLineId: 'a', quantity: new Prisma.Decimal(20) }],
    );
    expect(left.get('a')?.toString()).toBe('30');
    expect(left.get('b')?.toString()).toBe('100');
  });
});
