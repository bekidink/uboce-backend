import { describe, expect, it } from 'vitest';

import { parseAttributeFilters, toPrefixTsQuery } from './query.js';

describe('toPrefixTsQuery', () => {
  it('builds a prefix AND query', () => {
    expect(toPrefixTsQuery('Yirga Guji')).toBe('yirga:* & guji:*');
  });

  it('strips tsquery operators so input cannot change the query', () => {
    expect(toPrefixTsQuery("grade | !x & (y:*) <-> ' ")).toBe('grade:* & x:* & y:*');
  });

  it('expands synonyms across English and Amharic', () => {
    expect(toPrefixTsQuery('buna')).toBe('(buna:* | coffee:* | bunna:* | ቡና:*)');
    expect(toPrefixTsQuery('ጤፍ')).toBe('(ጤፍ:* | teff:* | tef:* | tefe:*)');
  });

  it('splits hyphenated synonyms into AND groups', () => {
    expect(toPrefixTsQuery('washed')).toBe('(washed:* | (wet:* & processed:*))');
  });

  it('returns null for empty input', () => {
    expect(toPrefixTsQuery('  !!  ')).toBeNull();
    expect(toPrefixTsQuery(undefined)).toBeNull();
  });
});

describe('parseAttributeFilters', () => {
  it('keeps well-formed key:value pairs only', () => {
    expect(parseAttributeFilters('grade:1, process:washed,Bad Key:x,empty:')).toEqual([
      ['grade', '1'],
      ['process', 'washed'],
    ]);
  });
});
