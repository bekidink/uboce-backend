import { describe, expect, it } from 'vitest';

import { sign, verifySignature } from './signature.js';

const SECRET = 'test-secret-at-least-16-chars';
const body = Buffer.from('{"eventId":"e1","amount":"100.00"}');
const now = 1_800_000_000_000;
const ts = String(now / 1000);

describe('webhook signatures', () => {
  it('accepts a fresh, correctly signed callback', () => {
    expect(verifySignature(SECRET, ts, sign(SECRET, ts, body), body, 300, now)).toEqual({ ok: true });
  });

  it('rejects tampering with the body', () => {
    const tampered = Buffer.from('{"eventId":"e1","amount":"999.00"}');
    expect(verifySignature(SECRET, ts, sign(SECRET, ts, body), tampered, 300, now)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects another secret', () => {
    expect(verifySignature(SECRET, ts, sign('another-secret-0123456', ts, body), body, 300, now)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects replays outside the time window', () => {
    const old = String(now / 1000 - 301);
    expect(verifySignature(SECRET, old, sign(SECRET, old, body), body, 300, now)).toEqual({ ok: false, reason: 'stale' });
  });

  it('rejects missing headers', () => {
    expect(verifySignature(SECRET, undefined, undefined, body, 300, now)).toEqual({ ok: false, reason: 'missing' });
  });
});
