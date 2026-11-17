import { Prisma } from '../generated/prisma/client.js';

// Delivery fee calculation from a seller's rate card (PRD v2 LOG-06), without I/O.

const { Decimal } = Prisma;

export interface RateZone {
  name: string;
  /** Cities or regions this zone covers, matched case-insensitively; "*" covers everywhere else. */
  areas: string[];
  baseFee: string;
  /** Added per kilogram of the order's shipping weight. */
  perKgFee: string;
  /** Heavier orders can't be delivered in this zone. */
  maxWeightKg?: string | null;
}

export type FeeResult =
  | { ok: true; zone: string; fee: string; freeDelivery: boolean }
  | { ok: false; reason: 'no_zone' | 'too_heavy'; message: string };

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

/** Specific areas win over the "*" fallback; the first matching zone applies. */
export function pickZone(zones: RateZone[], city?: string | null, region?: string | null) {
  const wanted = [norm(city), norm(region)].filter(Boolean);
  return zones.find((z) => z.areas.some((a) => wanted.includes(norm(a)))) ?? zones.find((z) => z.areas.some((a) => a.trim() === '*'));
}

export function deliveryFee(card: { zones: RateZone[]; freeOverAmount: string | null }, input: { goodsAmount: string; weightKg: string; city?: string | null; region?: string | null }): FeeResult {
  const zone = pickZone(card.zones, input.city, input.region);
  const where = [input.city, input.region].filter(Boolean).join(', ') || 'that address';
  if (!zone) return { ok: false, reason: 'no_zone', message: `The seller does not deliver to ${where}` };
  const weight = new Decimal(input.weightKg || '0');
  if (zone.maxWeightKg && weight.gt(zone.maxWeightKg)) return { ok: false, reason: 'too_heavy', message: `Orders over ${zone.maxWeightKg} kg can't be delivered to ${where}; choose pickup` };
  if (card.freeOverAmount && new Decimal(input.goodsAmount).gte(card.freeOverAmount)) return { ok: true, zone: zone.name, fee: '0.00', freeDelivery: true };
  const fee = new Decimal(zone.baseFee).plus(weight.times(zone.perKgFee)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return { ok: true, zone: zone.name, fee: fee.toFixed(2), freeDelivery: false };
}
