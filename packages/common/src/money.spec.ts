import { describe, expect, it } from 'vitest';

import { allocateProRata, fromMinorUnits, toMinorUnits } from './money.js';

describe('minor units', () => {
  it('converts two-decimal currencies without float error', () => {
    expect(toMinorUnits('1250.50', 'ETB')).toBe('125050');
    expect(toMinorUnits('0.29', 'USD')).toBe('29');
    expect(toMinorUnits('19.999', 'USD')).toBe('2000');
    expect(fromMinorUnits(125050, 'ETB')).toBe('1250.50');
    expect(fromMinorUnits(5, 'usd')).toBe('0.05');
  });

  it('handles zero- and three-decimal currencies', () => {
    expect(toMinorUnits('1500', 'JPY')).toBe('1500');
    expect(fromMinorUnits(1500, 'JPY')).toBe('1500');
    expect(toMinorUnits('1.234', 'KWD')).toBe('1234');
    expect(fromMinorUnits(1234, 'KWD')).toBe('1.234');
  });
});

describe('allocateProRata', () => {
  it('always sums to the amount', () => {
    const parts = allocateProRata('10.00', ['1', '1', '1']);
    expect(parts).toEqual(['3.34', '3.33', '3.33']);
    expect(allocateProRata('7.01', ['100', '250.50', '0.01']).reduce((s, p) => s + Math.round(Number(p) * 100), 0)).toBe(701);
  });

  it('puts everything on the first line when there is nothing to weigh by', () => {
    expect(allocateProRata('5', ['0', '0'])).toEqual(['5.00', '0.00']);
  });
});
