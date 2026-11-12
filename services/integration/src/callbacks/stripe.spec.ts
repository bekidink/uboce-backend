import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { verifyStripeSignature } from './signature.js';
import { fromStripe } from './stripe.js';

const SECRET = 'whsec_test_secret_at_least_16';
const now = 1_800_000_000_000;
const t = String(now / 1000);
const body = Buffer.from('{"id":"evt_1"}');
const v1 = (secret: string, ts: string) => createHmac('sha256', secret).update(`${ts}.`).update(body).digest('hex');

describe('Stripe signatures', () => {
  it('accepts a correctly signed event, also while the secret is being rolled', () => {
    expect(verifyStripeSignature(SECRET, `t=${t},v1=${v1(SECRET, t)}`, body, 300, now)).toEqual({ ok: true });
    expect(verifyStripeSignature(SECRET, `t=${t},v1=${v1('whsec_old_secret_0000000', t)},v1=${v1(SECRET, t)}`, body, 300, now)).toEqual({ ok: true });
  });

  it('rejects missing, stale and forged signatures', () => {
    expect(verifyStripeSignature(SECRET, undefined, body, 300, now)).toEqual({ ok: false, reason: 'missing' });
    const old = String(now / 1000 - 1000);
    expect(verifyStripeSignature(SECRET, `t=${old},v1=${v1(SECRET, old)}`, body, 300, now)).toEqual({ ok: false, reason: 'stale' });
    expect(verifyStripeSignature(SECRET, `t=${t},v1=${v1('whsec_wrong_secret_00000', t)}`, body, 300, now)).toEqual({ ok: false, reason: 'mismatch' });
  });
});

const session = (type: string, extra: Record<string, unknown> = {}) => ({
  id: 'evt_123',
  type,
  created: 1_800_000_000,
  data: {
    object: {
      object: 'checkout.session',
      amount_total: 125050,
      currency: 'etb',
      payment_status: 'paid',
      payment_intent: 'pi_1',
      client_reference_id: 'INV-2026-000001__abcd1234',
      metadata: { reference: 'INV-2026-000001__abcd1234', invoice_number: 'INV-2026-000001' },
      ...extra,
    },
  },
});

describe('Stripe events', () => {
  it('confirms a paid Checkout Session in major units', () => {
    expect(fromStripe(session('checkout.session.completed'))).toMatchObject({
      kind: 'payment',
      type: 'payment.confirmed',
      reference: 'INV-2026-000001__abcd1234',
      invoiceNumber: 'INV-2026-000001',
      amount: '1250.50',
      currency: 'ETB',
      paymentIntentId: 'pi_1',
    });
  });

  it('waits for delayed methods, and fails expired or failed sessions', () => {
    expect(fromStripe(session('checkout.session.completed', { payment_status: 'unpaid' }))).toMatchObject({ kind: 'ignored' });
    expect(fromStripe(session('checkout.session.async_payment_succeeded'))).toMatchObject({ type: 'payment.confirmed' });
    expect(fromStripe(session('checkout.session.async_payment_failed'))).toMatchObject({ type: 'payment.failed' });
    expect(fromStripe(session('checkout.session.expired', { payment_status: 'unpaid' }))).toMatchObject({ type: 'payment.failed' });
  });

  it('ignores sessions that are not ours', () => {
    expect(fromStripe(session('checkout.session.completed', { metadata: {}, client_reference_id: null }))).toMatchObject({ kind: 'ignored' });
  });

  it('maps refund outcomes by our refund number', () => {
    const refund = (status: string) => ({ id: 'evt_r', type: 'refund.updated', created: 1, data: { object: { id: 're_1', status, metadata: { refund_number: 'RF-2026-000001' } } } });
    expect(fromStripe(refund('succeeded'))).toMatchObject({ kind: 'refund', type: 'refund.succeeded', refundNumber: 'RF-2026-000001', providerRef: 're_1' });
    expect(fromStripe(refund('failed'))).toMatchObject({ kind: 'refund', type: 'refund.failed' });
    expect(fromStripe(refund('pending'))).toMatchObject({ kind: 'ignored' });
  });

  it('turns a lost dispute into a lookup, and rejects non-events', () => {
    expect(fromStripe({ id: 'evt_d', type: 'charge.dispute.closed', created: 1, data: { object: { status: 'lost', payment_intent: 'pi_9', amount: 500, currency: 'usd' } } })).toMatchObject({
      kind: 'dispute_lost',
      paymentIntentId: 'pi_9',
      amount: '5.00',
    });
    expect(fromStripe({ hello: 'world' })).toBeNull();
  });
});
