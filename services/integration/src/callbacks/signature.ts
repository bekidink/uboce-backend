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

/** Chapa signs its webhooks as hex HMAC-SHA256 of the raw body with the webhook secret (x-chapa-signature). */
export function verifyChapaSignature(secret: string, signature: string | undefined, rawBody: Buffer): SignatureCheck {
  if (!signature) return { ok: false, reason: 'missing' };
  const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { ok: false, reason: 'mismatch' };
  return { ok: true };
}

/**
 * Stripe signs webhooks as `Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>…]`, the hex being
 * HMAC-SHA256 of "<t>.<raw body>" with the endpoint's signing secret (whsec_…). Several v1
 * values appear while a secret is being rolled; any match is enough.
 */
export function verifyStripeSignature(secret: string, header: string | undefined, rawBody: Buffer, maxAgeSeconds: number, nowMs = Date.now()): SignatureCheck {
  if (!header) return { ok: false, reason: 'missing' };
  const parts = header.split(',').map((p) => p.trim().split('='));
  const timestamp = parts.find(([k]) => k === 't')?.[1];
  const signatures = parts.filter(([k, v]) => k === 'v1' && v).map(([, v]) => v!);
  if (!timestamp || !/^\d{9,12}$/.test(timestamp) || signatures.length === 0) return { ok: false, reason: 'missing' };
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > maxAgeSeconds) return { ok: false, reason: 'stale' };
  const expected = Buffer.from(createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex'));
  const match = signatures.some((s) => {
    const actual = Buffer.from(s);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
  return match ? { ok: true } : { ok: false, reason: 'mismatch' };
}
