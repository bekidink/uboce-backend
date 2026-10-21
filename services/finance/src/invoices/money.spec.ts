import { describe, expect, it } from 'vitest';

import { Prisma } from '../generated/prisma/client.js';
import { outstanding, priceLines, settlementStatus } from './money.js';

const d = (v: string | number) => new Prisma.Decimal(v);

describe('invoice arithmetic', () => {
  it('prices lines with per-line tax and exact totals', () => {
    const r = priceLines([
      { description: 'Coffee', quantity: '50', unitPrice: '18200', taxRatePct: '15' },
      { description: 'Bags', quantity: '100', unitPrice: '45.5', taxRatePct: '0' },
    ]);
    expect(r.subtotal.toString()).toBe('914550');
    expect(r.taxTotal.toString()).toBe('136500');
    expect(r.total.toString()).toBe('1051050');
  });

  it('rounds each line half-up to cents', () => {
    const r = priceLines([{ description: 'x', quantity: '3', unitPrice: '0.335', taxRatePct: '15' }]);
    expect(r.lines[0]!.subtotal.toString()).toBe('1.01');
    expect(r.lines[0]!.tax.toString()).toBe('0.15');
  });

  it('derives settlement status from amounts, counting credit notes', () => {
    const inv = (paid: number, credited = 0) => ({ total: d(100), paidAmount: d(paid), creditedAmount: d(credited) });
    expect(settlementStatus(inv(0))).toBe('issued');
    expect(settlementStatus(inv(40))).toBe('partially_paid');
    expect(settlementStatus(inv(80, 20))).toBe('paid');
    expect(outstanding(inv(30, 10)).toString()).toBe('60');
  });
});
