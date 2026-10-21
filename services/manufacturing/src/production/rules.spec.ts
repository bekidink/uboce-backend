import { describe, expect, it } from 'vitest';

import { Prisma } from '../generated/prisma/client.js';
import { newBatchCode, requiredMaterials, yieldPercent } from './rules.js';

const d = (v: string | number) => new Prisma.Decimal(v);

describe('production rules', () => {
  it('scales the recipe to the planned output, rounding materials up', () => {
    // Recipe: 100 kg roasted coffee from 120 kg green beans + 100 bags.
    const recipe = { outputQuantity: d(100), components: [{ itemId: 'green', quantity: d(120) }, { itemId: 'bags', quantity: d(100) }] };
    expect(requiredMaterials(recipe, d(250)).map((m) => m.quantity.toString())).toEqual(['300', '250']);
    expect(requiredMaterials({ outputQuantity: d(3), components: [{ itemId: 'x', quantity: d(1) }] }, d(1))[0]!.quantity.toString()).toBe('0.3334');
  });

  it('reports yield against plan', () => {
    expect(yieldPercent(d(237.5), d(250)).toString()).toBe('95');
  });

  it('generates batch codes', () => {
    expect(newBatchCode(2026)).toMatch(/^B-2026-[0-9A-Z]{6}$/);
  });
});
