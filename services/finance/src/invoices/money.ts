import { Prisma } from '../generated/prisma/client.js';

// Invoice arithmetic (PRD 5.15), without I/O. Two-decimal rounding per line,
// half-up, so line totals add up exactly to the invoice total.

const { Decimal } = Prisma;
type Decimal = Prisma.Decimal;

export interface LineInput {
  description: string;
  quantity: string;
  unitPrice: string;
  /** Percent, e.g. "15" for 15% VAT. Supplied per line; nothing is assumed per country. */
  taxRatePct: string;
}

export function priceLines(lines: LineInput[]) {
  const priced = lines.map((l) => {
    const subtotal = new Decimal(l.quantity).times(l.unitPrice).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const tax = subtotal.times(l.taxRatePct).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    return { ...l, subtotal, tax, total: subtotal.plus(tax) };
  });
  const sum = (pick: (l: (typeof priced)[number]) => Decimal) => priced.reduce((s, l) => s.plus(pick(l)), new Decimal(0));
  return { lines: priced, subtotal: sum((l) => l.subtotal), taxTotal: sum((l) => l.tax), total: sum((l) => l.total) };
}

export const outstanding = (inv: { total: Decimal; paidAmount: Decimal; creditedAmount: Decimal }) =>
  inv.total.minus(inv.paidAmount).minus(inv.creditedAmount);

/** Paid status follows from the amounts; draft, void and disputed are set explicitly. */
export function settlementStatus(inv: { total: Decimal; paidAmount: Decimal; creditedAmount: Decimal }): 'issued' | 'partially_paid' | 'paid' {
  const left = outstanding(inv);
  if (!left.greaterThan(0)) return 'paid';
  if (inv.paidAmount.greaterThan(0)) return 'partially_paid';
  return 'issued';
}
