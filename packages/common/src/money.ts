import { applyDecorators } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';

// Money and quantities travel as decimal strings and are computed with
// Prisma.Decimal, never JS floats (PRD 7.2).

/** Up to 14 integer digits and 4 decimals, no sign. */
export const DECIMAL_PATTERN = /^\d{1,14}(\.\d{1,4})?$/;

export const IsDecimalString = (example = '1250.00') =>
  applyDecorators(
    ApiProperty({ type: String, example, pattern: DECIMAL_PATTERN.source }),
    Matches(DECIMAL_PATTERN, { message: '$property must be a non-negative decimal string, e.g. "1250.00"' }),
  );

/** ISO 4217. ETB is the initial market currency but nothing assumes it (PRD 10). */
export const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export const IsCurrency = () =>
  applyDecorators(
    ApiProperty({ example: 'ETB', pattern: CURRENCY_PATTERN.source }),
    Matches(CURRENCY_PATTERN, { message: '$property must be an ISO 4217 code, e.g. ETB' }),
  );

// Card providers (Stripe) count money in the currency's minor unit. Most currencies have two
// decimals; these have none or three (ISO 4217 / Stripe's list).
const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
const THREE_DECIMAL = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);

export const minorUnitDigits = (currency: string) => (ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : THREE_DECIMAL.has(currency.toUpperCase()) ? 3 : 2);

/** "1250.50" ETB -> "125050". Works on the decimal string, so no float rounding. */
export function toMinorUnits(amount: string, currency: string): string {
  const digits = minorUnitDigits(currency);
  const [int = '0', frac = ''] = amount.split('.');
  const padded = (frac + '000').slice(0, digits);
  // Round half up on the first dropped digit.
  let minor = BigInt(int + padded);
  if (Number(frac[digits] ?? '0') >= 5) minor += 1n;
  return minor.toString();
}

/** 125050 ETB -> "1250.50". */
export function fromMinorUnits(minor: number | string, currency: string): string {
  const digits = minorUnitDigits(currency);
  const s = BigInt(minor).toString().padStart(digits + 1, '0');
  return digits === 0 ? s : `${s.slice(0, -digits)}.${s.slice(-digits)}`;
}
