import { describe, expect, it } from 'vitest';

import { Prisma } from '../generated/prisma/client.js';
import { noCharges, orderTotal } from './charges.js';

const D = (v: string) => new Prisma.Decimal(v);

describe('order charges', () => {
  it('spreads the discount over lines and keeps the cents exact', () => {
    const c = noCharges([{ quantity: '3', unitPrice: '10' }, { quantity: '1', unitPrice: '5.555' }], D('7'));
    expect(c.lines.map((l) => l.discountAmount.toFixed(2))).toEqual(['5.91', '1.09']);
    expect(c.lines.map((l) => l.netAmount.toFixed(2))).toEqual(['24.09', '4.47']);
  });

  it('adds delivery and tax on exclusive prices, but not inclusive tax twice', () => {
    const base = noCharges([{ quantity: '1', unitPrice: '100' }], D('0'));
    const exclusive = { ...base, calculated: true, deliveryFee: D('50'), deliveryTax: D('7.5'), lines: [{ ...base.lines[0]!, taxAmount: D('15') }] };
    expect(orderTotal(exclusive).toFixed(2)).toBe('172.50');
    const inclusive = { ...exclusive, taxInclusive: true, lines: [{ ...base.lines[0]!, netAmount: D('86.96'), taxAmount: D('13.04') }] };
    expect(orderTotal(inclusive).toFixed(2)).toBe('150.00');
  });
});
