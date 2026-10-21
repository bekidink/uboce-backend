import { createHmac, timingSafeEqual } from 'node:crypto';

// Webhook authentication (PRD 5.19, 9): HMAC-SHA256 over "<timestamp>.<raw body>"
// with a per-provider secret, sent as `x-uboce-signature: sha256=<hex>` and
// `x-uboce-timestamp: <unix seconds>`. Old timestamps are refused (replay).

export const sign = (secret: string, timestamp: string, rawBody: Buffer | string) =>
  `sha256=${createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex')}`;

export type SignatureCheck = { ok: true } | { ok: false; reason: 'missing' | 'stale' | 'mismatch' };

export function verifySignature(
  secret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  rawBody: Buffer,
  maxAgeSeconds: number,
  nowMs = Date.now(),
): SignatureCheck {
  if (!timestamp || !signature || !/^\d{9,12}$/.test(timestamp)) return { ok: false, reason: 'missing' };
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > maxAgeSeconds) return { ok: false, reason: 'stale' };
  const expected = Buffer.from(sign(secret, timestamp, rawBody));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { ok: false, reason: 'mismatch' };
  return { ok: true };
}
