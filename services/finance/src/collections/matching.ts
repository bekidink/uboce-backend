import { createHash, randomInt } from 'node:crypto';

import { Prisma } from '../generated/prisma/client.js';

// Pure helpers for collections (PRD v2 FIN-04, FIN-06): payment codes,
// statement parsing and the automatic matching rule. No I/O.

const { Decimal } = Prisma;
type Decimal = Prisma.Decimal;

// Crockford base32 without I, L, O, U: easy to read out over the phone and type into a bank app.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** e.g. "UB7K2M9QXH": "UB", 7 random characters and a check character that catches one typo. */
export function newPaymentCode(): string {
  let body = '';
  for (let i = 0; i < 7; i++) body += ALPHABET[randomInt(ALPHABET.length)];
  return `UB${body}${checkChar(body)}`;
}

function checkChar(body: string) {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += ALPHABET.indexOf(body[i]!) * (i + 1);
  return ALPHABET[sum % ALPHABET.length]!;
}

/** Valid codes found in free text (bank references are often truncated or padded). */
export function paymentCodesIn(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.toUpperCase().replace(/[\s-]/g, '').matchAll(/UB([0-9A-HJKMNP-TV-Z]{7})([0-9A-HJKMNP-TV-Z])/g)) {
    if (checkChar(m[1]!) === m[2]) found.add(`UB${m[1]}${m[2]}`);
  }
  return [...found];
}

/** Invoice numbers like INV-2026-000042 found in free text. */
export const invoiceNumbersIn = (text: string) => [...new Set([...text.toUpperCase().matchAll(/INV-\d{4}-\d{6}/g)].map((m) => m[0]))];

export interface StatementLineInput {
  bookedAt: string;
  amount: string;
  currency: string;
  reference: string;
  counterparty?: string;
  description?: string;
}

/** Stable identity of a statement line, so the same file imported twice adds nothing. */
export function fingerprint(accountLabel: string, l: StatementLineInput) {
  const parts = [accountLabel.trim().toLowerCase(), new Date(l.bookedAt).toISOString().slice(0, 10), new Decimal(l.amount).toFixed(2), l.currency.toUpperCase(), l.reference.trim(), (l.counterparty ?? '').trim()];
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

/**
 * Parses a bank's CSV export. Needs a header row naming date, amount and
 * reference columns (common bank spellings accepted); quoted fields, commas or
 * semicolons, and thousands separators are handled. Debits (negative) are skipped.
 */
export function parseStatementCsv(csv: string, currency: string): { lines: StatementLineInput[]; skipped: number } {
  const rows = csv.replace(/^﻿/, '').split(/\r?\n/).filter((r) => r.trim());
  if (rows.length < 2) return { lines: [], skipped: 0 };
  const sep = (rows[0]!.match(/;/g)?.length ?? 0) > (rows[0]!.match(/,/g)?.length ?? 0) ? ';' : ',';
  const header = splitCsv(rows[0]!, sep).map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => header.findIndex((h) => names.some((n) => h === n || h.includes(n)));
  const date = col('date', 'booked', 'value date', 'posting');
  const credit = col('credit', 'amount', 'deposit');
  const ref = col('reference', 'ref', 'narration', 'details');
  const who = col('payer', 'counterparty', 'from', 'name');
  const desc = col('description', 'memo', 'remark');
  const cur = col('currency', 'ccy');
  if (date < 0 || credit < 0 || ref < 0) throw new Error('The CSV needs date, amount (or credit) and reference columns');

  const lines: StatementLineInput[] = [];
  let skipped = 0;
  for (const row of rows.slice(1)) {
    const f = splitCsv(row, sep);
    const amount = (f[credit] ?? '').replace(/[,\s]/g, '').replace(/^\((.*)\)$/, '-$1');
    const when = new Date(f[date] ?? '');
    if (!/^-?\d+(\.\d+)?$/.test(amount) || Number.isNaN(when.getTime()) || !(Number(amount) > 0)) {
      skipped++;
      continue;
    }
    lines.push({
      bookedAt: when.toISOString(),
      amount,
      currency: (cur >= 0 && f[cur]?.trim()) || currency,
      reference: (f[ref] ?? '').trim(),
      counterparty: who >= 0 ? f[who]?.trim() || undefined : undefined,
      description: desc >= 0 && desc !== ref ? f[desc]?.trim() || undefined : undefined,
    });
  }
  return { lines, skipped };
}

function splitCsv(row: string, sep: string) {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < row.length; i++) {
    const c = row[i]!;
    if (quoted && c === '"' && row[i + 1] === '"') {
      cur += '"';
      i++;
    } else if (c === '"') {
      quoted = !quoted;
    } else if (c === sep && !quoted) {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

export interface MatchCandidate {
  id: string;
  number: string;
  paymentCode: string | null;
  currency: string;
  outstanding: Decimal;
  issuedAt: Date | null;
}

export type MatchDecision = { kind: 'match'; invoiceId: string; note: string } | { kind: 'queue'; invoiceId: string | null; note: string };

/**
 * The automatic rule: exactly one open invoice named in the reference (by
 * payment code, else invoice number), same currency, booked no earlier than a
 * day before issue, and the exact outstanding amount. Anything else, including
 * partial and over-payments, goes to the manual queue with the reason.
 */
export function decideMatch(line: StatementLineInput, candidates: MatchCandidate[]): MatchDecision {
  const text = `${line.reference} ${line.description ?? ''}`;
  const codes = paymentCodesIn(text);
  const numbers = invoiceNumbersIn(text);
  let named = candidates.filter((c) => c.paymentCode && codes.includes(c.paymentCode));
  if (named.length === 0) named = candidates.filter((c) => numbers.includes(c.number));
  if (named.length === 0) return { kind: 'queue', invoiceId: null, note: 'no open invoice named in the reference' };
  if (named.length > 1) return { kind: 'queue', invoiceId: null, note: 'the reference names more than one invoice' };
  const inv = named[0]!;
  if (inv.currency !== line.currency.toUpperCase()) return { kind: 'queue', invoiceId: inv.id, note: `currency ${line.currency} differs from the invoice` };
  if (inv.issuedAt && new Date(line.bookedAt).getTime() < inv.issuedAt.getTime() - 86_400_000) {
    return { kind: 'queue', invoiceId: inv.id, note: 'booked before the invoice was issued' };
  }
  const amount = new Decimal(line.amount);
  if (amount.equals(inv.outstanding)) return { kind: 'match', invoiceId: inv.id, note: `matched ${inv.number} by reference and amount` };
  return { kind: 'queue', invoiceId: inv.id, note: amount.lessThan(inv.outstanding) ? `partial payment of ${inv.number}` : `more than is outstanding on ${inv.number}` };
}
