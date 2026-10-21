import { randomBytes } from 'node:crypto';

import { Prisma } from '../generated/prisma/client.js';

// Production maths (PRD 5.12), without I/O.

const { Decimal } = Prisma;
type Decimal = Prisma.Decimal;

/** Materials needed for a planned output, scaled from the recipe. */
export function requiredMaterials(
  recipe: { outputQuantity: Decimal; components: { itemId: string; quantity: Decimal }[] },
  plannedOutput: Decimal,
) {
  const factor = plannedOutput.dividedBy(recipe.outputQuantity);
  return recipe.components.map((c) => ({ itemId: c.itemId, quantity: c.quantity.times(factor).toDecimalPlaces(4, Decimal.ROUND_UP) }));
}

/** Yield as a percentage of plan, two decimals. */
export const yieldPercent = (output: Decimal, planned: Decimal) => output.dividedBy(planned).times(100).toDecimalPlaces(2);

/** e.g. B-2026-0Q7MZK */
export function newBatchCode(year = new Date().getUTCFullYear()) {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  return `B-${year}-${[...randomBytes(6)].map((b) => alphabet[b % alphabet.length]).join('')}`;
}
