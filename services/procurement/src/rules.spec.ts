import { describe, expect, it } from 'vitest';

import { canSupplierSee, priceQuotation, quotingBlocker, type RfqForEligibility } from './rules.js';

const rfq = (overrides: Partial<RfqForEligibility> = {}): RfqForEligibility => ({
  buyerOrganizationId: 'buyer',
  status: 'published',
  visibility: 'invited',
  responseDeadline: new Date(Date.now() + 86_400_000),
  invitedSupplierIds: ['s1'],
  ...overrides,
});

describe('supplier eligibility', () => {
  it('limits invited RFQs to invited suppliers', () => {
    expect(canSupplierSee(rfq(), 's1')).toBe(true);
    expect(canSupplierSee(rfq(), 's2')).toBe(false);
    expect(canSupplierSee(rfq({ visibility: 'open' }), 's2')).toBe(true);
  });

  it('never lets the buyer quote on its own RFQ or anyone see drafts', () => {
    expect(canSupplierSee(rfq({ visibility: 'open' }), 'buyer')).toBe(false);
    expect(canSupplierSee(rfq({ status: 'draft', visibility: 'open' }), 's1')).toBe(false);
  });

  it('closes quoting at the deadline and after award', () => {
    expect(quotingBlocker(rfq(), 's1')).toBeNull();
    expect(quotingBlocker(rfq({ responseDeadline: new Date(Date.now() - 1) }), 's1')).toBe('deadline_passed');
    expect(quotingBlocker(rfq({ status: 'awarded' }), 's1')).toBe('rfq_not_open');
  });
});

describe('priceQuotation', () => {
  const lines = [
    { id: 'l1', quantity: '100' },
    { id: 'l2', quantity: '2.5' },
  ];

  it('totals with exact decimal maths', () => {
    const { total, lines: priced } = priceQuotation(lines, [
      { rfqLineId: 'l1', unitPrice: '0.1' },
      { rfqLineId: 'l2', unitPrice: '0.2' },
    ]);
    expect(priced.map((l) => l.lineTotal.toString())).toEqual(['10', '0.5']);
    expect(total.toString()).toBe('10.5');
  });

  it('requires every line exactly once and nothing else', () => {
    expect(() => priceQuotation(lines, [{ rfqLineId: 'l1', unitPrice: '1' }])).toThrow('Every RFQ line');
    expect(() =>
      priceQuotation(lines, [
        { rfqLineId: 'l1', unitPrice: '1' },
        { rfqLineId: 'l1', unitPrice: '2' },
        { rfqLineId: 'l2', unitPrice: '1' },
      ]),
    ).toThrow('only once');
    expect(() =>
      priceQuotation(lines, [
        { rfqLineId: 'l1', unitPrice: '1' },
        { rfqLineId: 'l2', unitPrice: '1' },
        { rfqLineId: 'zz', unitPrice: '1' },
      ]),
    ).toThrow('not on this RFQ');
  });
});
