import { describe, expect, it } from 'vitest';

import { calculateTax, pickRule, TaxRuleMissing } from './engine.js';

const at = new Date('2026-11-13');
const rules = [
  { id: 'vat15', code: 'VAT', regime: 'vat', taxClass: 'standard', ratePct: '15', effectiveFrom: new Date('2019-01-01'), effectiveTo: null },
  { id: 'vat0', code: 'VAT', regime: 'vat', taxClass: 'zero_rated', ratePct: '0', effectiveFrom: new Date('2019-01-01'), effectiveTo: null },
  { id: 'tot2', code: 'TOT', regime: 'tot', taxClass: 'standard', ratePct: '2', effectiveFrom: new Date('2019-01-01'), effectiveTo: null },
  { id: 'tot10', code: 'TOT', regime: 'tot', taxClass: 'service', ratePct: '10', effectiveFrom: new Date('2019-01-01'), effectiveTo: null },
  { id: 'old', code: 'VAT', regime: 'vat', taxClass: 'standard', ratePct: '10', effectiveFrom: new Date('2010-01-01'), effectiveTo: new Date('2019-01-01') },
];

describe('pickRule', () => {
  it('uses the rule in force on the date, falling back to the standard class', () => {
    expect(pickRule(rules, 'vat', 'standard', at)?.id).toBe('vat15');
    expect(pickRule(rules, 'vat', 'standard', new Date('2015-06-01'))?.id).toBe('old');
    expect(pickRule(rules, 'tot', 'zero_rated', at)?.id).toBe('tot2');
  });
});

describe('calculateTax', () => {
  it('adds VAT on exclusive prices and rounds per line', () => {
    const r = calculateTax({ regime: 'vat', inclusive: false, exemption: null, rules, at, lines: [{ key: 'a', amount: '10.03' }, { key: 'b', amount: '99.99', taxClass: 'zero_rated' }] });
    expect(r.lines.map((l) => l.tax)).toEqual(['1.50', '0.00']);
    expect(r).toMatchObject({ net: '110.02', tax: '1.50', gross: '111.52' });
  });

  it('extracts VAT from inclusive prices so net + tax = price', () => {
    const r = calculateTax({ regime: 'vat', inclusive: true, exemption: null, rules, at, lines: [{ key: 'a', amount: '115' }] });
    expect(r.lines[0]).toMatchObject({ net: '100.00', tax: '15.00', gross: '115.00' });
  });

  it('line taxes always sum to the total', () => {
    const lines = Array.from({ length: 40 }, (_, i) => ({ key: String(i), amount: (i * 7.37 + 0.01).toFixed(2) }));
    const r = calculateTax({ regime: 'vat', inclusive: false, exemption: null, rules, at, lines });
    const sum = r.lines.reduce((s, l) => s + Math.round(Number(l.tax) * 100), 0);
    expect(sum).toBe(Math.round(Number(r.tax) * 100));
  });

  it('charges nothing for unregistered sellers, exempt buyers or exempt goods', () => {
    expect(calculateTax({ regime: 'none', inclusive: false, exemption: null, rules, at, lines: [{ key: 'a', amount: '50' }] }).tax).toBe('0.00');
    expect(calculateTax({ regime: 'vat', inclusive: false, exemption: 'CERT-1', rules, at, lines: [{ key: 'a', amount: '50' }] }).lines[0]!.taxCode).toBe('EXEMPT');
    expect(calculateTax({ regime: 'vat', inclusive: false, exemption: null, rules, at, lines: [{ key: 'a', amount: '50', taxClass: 'exempt' }] }).tax).toBe('0.00');
  });

  it('uses TOT service rates and fails loudly without a rule', () => {
    expect(calculateTax({ regime: 'tot', inclusive: false, exemption: null, rules, at, lines: [{ key: 'a', amount: '100', taxClass: 'service' }] }).tax).toBe('10.00');
    expect(() => calculateTax({ regime: 'vat', inclusive: false, exemption: null, rules: [], at, lines: [{ key: 'a', amount: '1' }] })).toThrow(TaxRuleMissing);
  });
});
