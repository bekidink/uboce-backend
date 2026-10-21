import { randomBytes } from 'node:crypto';

import { Prisma } from '../generated/prisma/client.js';

// Lot quantity accounting (PRD 6.4: transformations preserve lineage and quantities).

const { Decimal } = Prisma;
type Decimal = Prisma.Decimal;

/** e.g. LOT-2026-7K3QX9 — short enough to print on a bag tag. */
export function newLotCode(year = new Date().getUTCFullYear()) {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = randomBytes(6);
  return `LOT-${year}-${[...bytes].map((b) => alphabet[b % alphabet.length]).join('')}`;
}

/** A split must leave nothing negative and create at least two meaningful parts. */
export function validateSplit(available: Decimal, parts: string[]): string | null {
  if (parts.length < 2) return 'Split into at least two parts';
  const values = parts.map((p) => new Decimal(p));
  if (values.some((v) => !v.greaterThan(0))) return 'Every part needs a positive quantity';
  const total = values.reduce((a, b) => a.plus(b), new Decimal(0));
  if (total.greaterThan(available)) return `Parts total ${total.toString()} but the lot holds ${available.toString()}`;
  return null;
}

/** How much of a harvest is still unassigned to lots. */
export const harvestRemaining = (harvested: Decimal, alreadyUsed: Decimal[]) =>
  alreadyUsed.reduce((left, used) => left.minus(used), harvested);

export interface TraceNode {
  lotId: string;
  lotCode: string;
  quantity: string;
  origin: string;
  grade: string | null;
  parents: { quantity: string; lot: TraceNode }[];
  harvests: { quantity: string; harvestId: string; harvestedAt: string; crop: string; season: string; year: number; farm: { id: string; name: string; region: string | null } }[];
}
