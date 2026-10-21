import { describe, expect, it } from 'vitest';

import { Prisma } from '../generated/prisma/client.js';
import { harvestRemaining, newLotCode, validateSplit } from './lineage.js';

const d = (v: string | number) => new Prisma.Decimal(v);

describe('lot lineage rules', () => {
  it('splits conserve quantity', () => {
    expect(validateSplit(d(50), ['30', '20'])).toBeNull();
    expect(validateSplit(d(50), ['30', '25'])).toContain('holds 50');
    expect(validateSplit(d(50), ['50'])).toContain('at least two');
    expect(validateSplit(d(50), ['50', '0'])).toContain('positive');
  });

  it('tracks what is left of a harvest', () => {
    expect(harvestRemaining(d(100), [d(40), d(35)]).toString()).toBe('25');
  });

  it('generates printable lot codes', () => {
    expect(newLotCode(2026)).toMatch(/^LOT-2026-[2-9A-HJ-NP-Z]{6}$/);
  });
});
