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
