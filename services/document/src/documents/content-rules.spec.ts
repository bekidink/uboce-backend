import { describe, expect, it } from 'vitest';

import { matchesSignature, retentionUntil, safeFileName } from './content-rules.js';

describe('content signatures', () => {
  it('accepts real file headers', () => {
    expect(matchesSignature('application/pdf', Buffer.from('%PDF-1.7\n'))).toBe(true);
    expect(matchesSignature('image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe(true);
    expect(matchesSignature('image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
  });

  it('rejects content that does not match the declared type', () => {
    expect(matchesSignature('application/pdf', Buffer.from('MZ\x90\x00'))).toBe(false);
    expect(matchesSignature('image/png', Buffer.from('%PDF-1.7'))).toBe(false);
    expect(matchesSignature('text/html', Buffer.from('<html>'))).toBe(false);
  });
});

describe('retention', () => {
  it('keeps regulated documents and lets others go', () => {
    const from = new Date('2026-01-15T00:00:00Z');
    expect(retentionUntil('invoice', from)?.toISOString()).toBe('2036-01-15T00:00:00.000Z');
    expect(retentionUntil('product_image', from)).toBeNull();
  });
});

describe('safeFileName', () => {
  it('strips paths and unsafe characters', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('C:\\x\\"inv"<1>.pdf')).toBe('_inv__1_.pdf');
    expect(safeFileName('')).toBe('file');
  });
});
