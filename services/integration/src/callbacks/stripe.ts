// Stripe webhook events, translated to the normalized payment and refund callbacks
// Finance already understands. Finance's Stripe adapter (finance/src/payments/providers.ts)
// puts our reference and the invoice number in the Checkout Session and PaymentIntent
// metadata, and the refund number in the refund metadata; that is all we read back.

import { fromMinorUnits } from '@uboce/common';
import { z } from 'zod';

import { env } from '../config.js';

export type StripeTranslation =
  | {
      kind: 'payment';
      eventId: string;
      type: 'payment.confirmed' | 'payment.failed' | 'payment.reversed';
      reference: string;
      invoiceNumber: string;
      amount: string;
      currency: string;
      fee?: string;
      occurredAt: string;
      /** Stripe's PaymentIntent, used to look up the real fee. */
      paymentIntentId?: string;
    }
  | { kind: 'refund'; eventId: string; type: 'refund.succeeded' | 'refund.failed'; refundNumber: string; providerRef?: string; reason?: string; occurredAt: string }
  | { kind: 'dispute_lost'; eventId: string; paymentIntentId: string; amount: string; currency: string; occurredAt: string }
  /** A valid event we don't act on (other types, pending states): acknowledged so Stripe stops retrying. */
  | { kind: 'ignored'; eventId: string; type: string };

const eventSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.string().min(1).max(100),
  created: z.number().int(),
  data: z.object({ object: z.record(z.string(), z.unknown()) }),
});

const metadata = (o: Record<string, unknown>) => (o.metadata && typeof o.metadata === 'object' ? (o.metadata as Record<string, unknown>) : {});
const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined);

export function fromStripe(body: unknown): StripeTranslation | null {
  const e = eventSchema.safeParse(body);
  if (!e.success) return null;
  const { id, type, created } = e.data;
  const o = e.data.data.object;
  const occurredAt = new Date(created * 1000).toISOString();

  if (type.startsWith('checkout.session.')) {
    const meta = metadata(o);
    const reference = str(meta.reference) ?? str(o.client_reference_id);
    const invoiceNumber = str(meta.invoice_number);
    const currency = str(o.currency)?.toUpperCase();
    // Sessions created outside UBOCE (no reference) are not ours to apply.
    if (!reference || !invoiceNumber || !currency || typeof o.amount_total !== 'number') return { kind: 'ignored', eventId: id, type };
    let status: 'payment.confirmed' | 'payment.failed' | null = null;
    // "completed" with payment_status unpaid means a delayed method (bank debit): wait for async_payment_*.
    if ((type === 'checkout.session.completed' && o.payment_status === 'paid') || type === 'checkout.session.async_payment_succeeded') status = 'payment.confirmed';
    else if (type === 'checkout.session.async_payment_failed' || type === 'checkout.session.expired') status = 'payment.failed';
    if (!status) return { kind: 'ignored', eventId: id, type };
    return {
      kind: 'payment',
      eventId: id,
      type: status,
      reference,
      invoiceNumber,
      amount: fromMinorUnits(o.amount_total, currency),
      currency,
      occurredAt,
      paymentIntentId: str(o.payment_intent),
    };
  }

  if (type === 'refund.created' || type === 'refund.updated' || type === 'charge.refund.updated') {
    const refundNumber = str(metadata(o).refund_number);
    if (!refundNumber) return { kind: 'ignored', eventId: id, type };
    const status = o.status;
    if (status === 'succeeded') return { kind: 'refund', eventId: id, type: 'refund.succeeded', refundNumber, providerRef: str(o.id), occurredAt };
    if (status === 'failed' || status === 'canceled')
      return { kind: 'refund', eventId: id, type: 'refund.failed', refundNumber, providerRef: str(o.id), reason: str(o.failure_reason) ?? `refund ${status}`, occurredAt };
    return { kind: 'ignored', eventId: id, type };
  }

  // A lost chargeback takes the money back. Disputes don't carry the PaymentIntent's metadata,
  // so the caller looks the reference up (needs STRIPE_SECRET_KEY here).
  if (type === 'charge.dispute.closed' && o.status === 'lost') {
    const paymentIntentId = str(o.payment_intent);
    const currency = str(o.currency)?.toUpperCase();
    if (!paymentIntentId || !currency || typeof o.amount !== 'number') return { kind: 'ignored', eventId: id, type };
    return { kind: 'dispute_lost', eventId: id, paymentIntentId, amount: fromMinorUnits(o.amount, currency), currency, occurredAt };
  }

  return { kind: 'ignored', eventId: id, type };
}

/**
 * Looks up a PaymentIntent: our metadata (reference, invoice number) and Stripe's actual fee from
 * the charge's balance transaction. Needs STRIPE_SECRET_KEY here; without it (or on any error) it
 * returns null and Finance falls back to its configured fee percentage.
 */
export async function stripePaymentIntent(paymentIntentId: string): Promise<{ reference?: string; invoiceNumber?: string; fee?: { amount: number; currency: string } } | null> {
  if (!env.STRIPE_SECRET_KEY) return null;
  try {
    const url = `${env.STRIPE_API_URL}/payment_intents/${encodeURIComponent(paymentIntentId)}?expand[]=latest_charge.balance_transaction`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const pi = (await res.json()) as { metadata?: Record<string, string>; latest_charge?: { balance_transaction?: { fee?: number; currency?: string } } };
    const bt = pi.latest_charge?.balance_transaction;
    return {
      reference: pi.metadata?.reference,
      invoiceNumber: pi.metadata?.invoice_number,
      fee: typeof bt?.fee === 'number' && bt.currency ? { amount: bt.fee, currency: bt.currency.toUpperCase() } : undefined,
    };
  } catch {
    return null;
  }
}

/** Stripe's fee in the payment's currency, or undefined to use Finance's percentage. */
export async function stripeFee(paymentIntentId: string, currency: string): Promise<string | undefined> {
  const pi = await stripePaymentIntent(paymentIntentId);
  return pi?.fee && pi.fee.currency === currency ? fromMinorUnits(pi.fee.amount, currency) : undefined;
}
