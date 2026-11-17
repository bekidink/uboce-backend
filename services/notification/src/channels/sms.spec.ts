import { describe, expect, it } from 'vitest';

import { receiptStatus, smsSegments } from './sms.provider.js';

describe('smsSegments', () => {
  it('counts GSM text at 160 and Amharic at 70 characters per part', () => {
    expect(smsSegments('a'.repeat(160))).toBe(1);
    expect(smsSegments('a'.repeat(161))).toBe(2);
    expect(smsSegments('ሀ'.repeat(70))).toBe(1);
    expect(smsSegments('ሀ'.repeat(71))).toBe(2);
  });
});

describe('receiptStatus', () => {
  it('normalises gateway states', () => {
    expect(receiptStatus('DELIVRD')).toBe('delivered');
    expect(receiptStatus('Undelivered')).toBe('failed');
    expect(receiptStatus('queued')).toBeNull();
  });
});
