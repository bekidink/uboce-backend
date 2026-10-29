import { describe, expect, it } from 'vitest';

import { attributeTypeProblems, availability, normalizeAttributes, publicationProblems, tierFor } from './publishing.js';

describe('publication rules', () => {
  it('requires the category attributes and an active variant', () => {
    expect(publicationProblems({ attributes: { origin: 'Sidama' }, variants: [] }, ['origin', 'grade'])).toEqual([
      'Missing required attributes: grade',
      'At least one active variant with a price is required',
    ]);
  });

  it('treats blank values as missing', () => {
    expect(publicationProblems({ attributes: { grade: '  ' }, variants: [{ isActive: true }] }, ['grade'])).toHaveLength(1);
  });

  it('passes a complete product', () => {
    expect(publicationProblems({ attributes: { grade: '1' }, variants: [{ isActive: false }, { isActive: true }] }, ['grade'])).toEqual([]);
  });
});

describe('normalizeAttributes', () => {
  it('trims values and rejects bad keys or values', () => {
    expect(normalizeAttributes({ grade: ' 1 ' })).toEqual({ grade: '1' });
    expect(() => normalizeAttributes({ 'Bad Key': 'x' })).toThrow();
    expect(() => normalizeAttributes({ grade: 5 })).toThrow();
  });
});

describe('typed attributes', () => {
  const defs = [
    { key: 'grade', label: 'Grade', type: 'enum' as const, options: ['1', '2'], required: true },
    { key: 'moisture_pct', label: 'Moisture', type: 'number' as const, unit: '%', max: 20 },
    { key: 'organic', label: 'Organic', type: 'boolean' as const },
  ];
  it('takes required keys from the definitions', () => {
    expect(publicationProblems({ attributes: {}, variants: [{ isActive: true }] }, ['legacy'], defs)).toEqual(['Missing required attributes: grade']);
  });
  it('checks numbers, options and booleans', () => {
    expect(attributeTypeProblems({ grade: '3', moisture_pct: '25', organic: 'yes' }, defs)).toEqual([
      'Grade must be one of: 1, 2',
      'Moisture must be at most 20%',
      'Organic must be true or false',
    ]);
    expect(attributeTypeProblems({ grade: '1', moisture_pct: '11.5', organic: 'true' }, defs)).toEqual([]);
  });
});

describe('pricing helpers', () => {
  it('picks the largest tier at or below the quantity', () => {
    const tiers = [{ minQuantity: 100, unitPrice: 9 }, { minQuantity: 1000, unitPrice: 8 }];
    expect(tierFor(tiers, 50)).toBeNull();
    expect(tierFor(tiers, 100)?.unitPrice).toBe(9);
    expect(tierFor(tiers, 5000)?.unitPrice).toBe(8);
  });
  it('allows pre-orders only before the season', () => {
    const now = new Date('2026-06-01');
    const season = { availableFrom: new Date('2026-10-01'), availableUntil: new Date('2027-01-31') };
    expect(availability({ ...season, allowPreorder: true }, now)).toEqual({ orderable: true, preorder: true });
    expect(availability({ ...season, allowPreorder: false }, now).orderable).toBe(false);
    expect(availability({ ...season, allowPreorder: true }, new Date('2027-03-01')).orderable).toBe(false);
    expect(availability({ ...season, allowPreorder: false }, new Date('2026-11-01'))).toEqual({ orderable: true, preorder: false });
  });
});
