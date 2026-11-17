import { describe, expect, it } from 'vitest';

import { maskPhone, normalizePhone } from './phone.js';

describe('normalizePhone', () => {
  it('accepts Ethiopian local and international forms', () => {
    for (const input of ['0911234567', '911234567', '+251 91 123 4567', '00251911234567', '251-911-234-567']) {
      expect(normalizePhone(input)).toBe('+251911234567');
    }
    expect(normalizePhone('0712345678')).toBe('+251712345678');
  });

  it('accepts other countries in international form only', () => {
    expect(normalizePhone('+14155550123')).toBe('+14155550123');
    expect(normalizePhone('4155550123')).toBeNull();
  });

  it('rejects landlines and junk for Ethiopia', () => {
    expect(normalizePhone('+251111234567')).toBeNull();
    expect(normalizePhone('09112')).toBeNull();
    expect(normalizePhone('abc')).toBeNull();
  });

  it('masks', () => {
    expect(maskPhone('+251911234567')).toBe('+2519****67');
  });
});
