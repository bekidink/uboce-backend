import { Prisma } from '../generated/prisma/client.js';

// The tax engine (PRD v2 FIN-09), without I/O. Rules are data: a rate per
// regime and tax class with effective dates. Fixed order: pick the rule, then
// tax each line, rounding half-up to cents per line; totals are line sums, so
// lines always add up to the total.

const { Decimal } = Prisma;
type Decimal = Prisma.Decimal;

export type TaxRegime = 'vat' | 'tot' | 'none';

export interface TaxRuleInput {
  id: string;
  code: string;
  regime: string;
  taxClass: string;
  ratePct: Decimal | string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

export interface TaxLineInput {
  key: string;
  /** Net of discounts; includes tax when prices are tax-inclusive. */
  amount: string;
  taxClass?: string | null;
}

export interface TaxedLine {
  key: string;
  taxCode: string;
  ratePct: string;
  ruleId: string | null;
  net: string;
  tax: string;
  gross: string;
}

export class TaxRuleMissing extends Error {}

/** The rule in force at `at` for a regime and class; `standard` is the fallback class. */
export function pickRule(rules: TaxRuleInput[], regime: TaxRegime, taxClass: string, at: Date) {
  const live = rules.filter((r) => r.regime === regime && r.effectiveFrom <= at && (!r.effectiveTo || r.effectiveTo > at));
  const newest = (list: TaxRuleInput[]) => list.sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0];
  return newest(live.filter((r) => r.taxClass === taxClass)) ?? (taxClass === 'standard' ? undefined : newest(live.filter((r) => r.taxClass === 'standard')));
}

export function calculateTax(input: { regime: TaxRegime; inclusive: boolean; exemption: string | null; rules: TaxRuleInput[]; lines: TaxLineInput[]; at: Date }) {
  const lines: TaxedLine[] = input.lines.map((l) => {
    const amount = new Decimal(l.amount);
    const cls = l.taxClass || 'standard';
    let code: string;
    let rate = new Decimal(0);
    let ruleId: string | null = null;
    if (input.regime === 'none') code = 'NONE';
    else if (input.exemption) code = 'EXEMPT';
    else if (cls === 'exempt') code = 'EXEMPT';
    else {
      const rule = pickRule(input.rules, input.regime, cls, input.at);
      if (!rule) throw new TaxRuleMissing(`No ${input.regime.toUpperCase()} rule for class ${cls} on ${input.at.toISOString().slice(0, 10)}`);
      code = rule.code;
      rate = new Decimal(rule.ratePct);
      ruleId = rule.id;
    }
    const tax = input.inclusive
      ? amount.times(rate).dividedBy(rate.plus(100)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
      : amount.times(rate).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const net = input.inclusive ? amount.minus(tax) : amount;
    return { key: l.key, taxCode: code, ratePct: rate.toFixed(2), ruleId, net: net.toFixed(2), tax: tax.toFixed(2), gross: net.plus(tax).toFixed(2) };
  });
  const sum = (pick: (l: TaxedLine) => string) => lines.reduce((s, l) => s.plus(pick(l)), new Decimal(0)).toFixed(2);
  return { lines, net: sum((l) => l.net), tax: sum((l) => l.tax), gross: sum((l) => l.gross) };
}

/** Ethiopian TIN: 10 digits. VAT registration numbers vary, so only their shape is checked. */
export const TIN_PATTERN = /^\d{10}$/;
