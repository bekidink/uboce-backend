import { describe, expect, it } from 'vitest';

import { toPrefixTsQuery } from './query.js';

describe('toPrefixTsQuery', () => {
  it('builds a prefix AND query', () => {
    expect(toPrefixTsQuery('Yirga Coffee')).toBe('yirga:* & coffee:*');
  });

  it('strips tsquery operators so input cannot change the query', () => {
    expect(toPrefixTsQuery("coffee | !teff & (x:*) <-> ' ")).toBe('coffee:* & teff:* & x:*');
  });

  it('keeps Amharic words', () => {
    expect(toPrefixTsQuery('ቡና ጤፍ')).toBe('ቡና:* & ጤፍ:*');
  });

  it('returns null for empty input', () => {
    expect(toPrefixTsQuery('  !!  ')).toBeNull();
    expect(toPrefixTsQuery(undefined)).toBeNull();
  });
});
