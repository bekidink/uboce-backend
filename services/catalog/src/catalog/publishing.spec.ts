import { describe, expect, it } from 'vitest';

import { normalizeAttributes, publicationProblems } from './publishing.js';

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
