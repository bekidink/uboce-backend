// Payment provider adapters (PRD addendum 2.7). Each provider gets one adapter behind the same
// interface; Finance never talks to a provider API anywhere else. Confirmations always arrive
// through Integration's signed callbacks, never from the buyer's browser.

import { Injectable, Logger } from '@nestjs/common';

import { env } from '../config.js';

export interface CheckoutRequest {
  intentId: string;
  /** Our transaction reference, sent to the provider and quoted back in callbacks. */
  reference: string;
  invoiceNumber: string;
  amount: string;
  currency: string;
  description: string;
  returnUrl: string;
  callbackUrl: string;
  payerEmail?: string | null;
}

export interface CheckoutResult {
  /** Where to send the buyer; null for offline methods (bank transfer). */
  checkoutUrl: string | null;
  /** The provider's own reference when it differs from ours. */
  providerRef?: string;
  instructions?: string;
}

export interface RefundRequest {
  refundNumber: string;
  /** The original payment's reference at the provider. */
  paymentRef: string;
  amount: string;
  currency: string;
  reason: string;
}

export interface RefundResult {
  status: 'processing' | 'succeeded';
  providerRef: string | null;
}

export interface PaymentProvider {
  readonly name: string;
  readonly label: string;
  /** True when the provider can send money back itself. */
  readonly supportsRefunds: boolean;
  createCheckout(req: CheckoutRequest): Promise<CheckoutResult>;
  refund(req: RefundRequest): Promise<RefundResult>;
}

export class ProviderError extends Error {}

/** Offline: the buyer pays by bank transfer and reports the reference; the seller confirms it. */
class ManualProvider implements PaymentProvider {
  readonly name = 'manual';
  readonly label = 'Bank transfer';
  readonly supportsRefunds = false;
  async createCheckout(req: CheckoutRequest): Promise<CheckoutResult> {
    return { checkoutUrl: null, instructions: `Transfer ${req.amount} ${req.currency} quoting ${req.invoiceNumber}, then report the transfer reference on the invoice.` };
  }
  async refund(): Promise<RefundResult> {
    throw new ProviderError('Bank transfers are refunded manually');
  }
}

/** For demos and tests: a fake checkout page in the web app; the outcome comes back as a signed callback. */
class SandboxProvider implements PaymentProvider {
  readonly name = 'sandbox';
  readonly label = 'Sandbox (test payments)';
  readonly supportsRefunds = true;
  async createCheckout(req: CheckoutRequest): Promise<CheckoutResult> {
    return { checkoutUrl: `${env.APP_BASE_URL}/pay/sandbox?intent=${req.intentId}&ref=${encodeURIComponent(req.reference)}` };
  }
  async refund(req: RefundRequest): Promise<RefundResult> {
    return { status: 'succeeded', providerRef: `sandbox-refund-${req.refundNumber}` };
  }
}

/** Chapa (Ethiopia): hosted checkout; callbacks arrive at Integration as provider "chapa". */
class ChapaProvider implements PaymentProvider {
  readonly name = 'chapa';
  readonly label = 'Chapa (telebirr, CBE Birr, cards)';
  readonly supportsRefunds = true;
  constructor(private readonly secret: string) {}

  private async call(path: string, body: object) {
    const res = await fetch(`${env.CHAPA_API_URL}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as { status?: string; message?: unknown; data?: Record<string, unknown> };
    if (!res.ok || json.status !== 'success') throw new ProviderError(`Chapa: ${typeof json.message === 'string' ? json.message : JSON.stringify(json.message ?? res.status)}`);
    return json.data ?? {};
  }

  async createCheckout(req: CheckoutRequest): Promise<CheckoutResult> {
    const data = await this.call('/transaction/initialize', {
      amount: req.amount,
      currency: req.currency,
      tx_ref: req.reference,
      callback_url: req.callbackUrl,
      return_url: req.returnUrl,
      email: req.payerEmail ?? undefined,
      customization: { title: 'UBOCE', description: req.description.slice(0, 50) },
    });
    return { checkoutUrl: String(data.checkout_url) };
  }

  async refund(req: RefundRequest): Promise<RefundResult> {
    const data = await this.call(`/refund/${encodeURIComponent(req.paymentRef)}`, { amount: req.amount, reason: req.reason, reference: req.refundNumber });
    return { status: 'processing', providerRef: (data.ref_id as string | undefined) ?? req.refundNumber };
  }
}

/** Stripe Checkout (cards, international buyers). */
class StripeProvider implements PaymentProvider {
  readonly name = 'stripe';
  readonly label = 'Card (Stripe)';
  readonly supportsRefunds = true;
  constructor(private readonly secret: string) {}

  private async call(path: string, form: Record<string, string>) {
    const res = await fetch(`${env.STRIPE_API_URL}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.secret}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: { message?: string } };
    if (!res.ok) throw new ProviderError(`Stripe: ${json.error?.message ?? res.status}`);
    return json;
  }

  async createCheckout(req: CheckoutRequest): Promise<CheckoutResult> {
    // Stripe amounts are in the currency's minor unit.
    const minor = Math.round(Number(req.amount) * 100).toString();
    const session = await this.call('/checkout/sessions', {
      mode: 'payment',
      success_url: req.returnUrl,
      cancel_url: req.returnUrl,
      client_reference_id: req.reference,
      'metadata[reference]': req.reference,
      'metadata[invoice_number]': req.invoiceNumber,
      'payment_intent_data[metadata][reference]': req.reference,
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': req.currency.toLowerCase(),
      'line_items[0][price_data][unit_amount]': minor,
      'line_items[0][price_data][product_data][name]': req.description.slice(0, 120),
    });
    return { checkoutUrl: String(session.url) };
  }

  async refund(req: RefundRequest): Promise<RefundResult> {
    const refund = await this.call('/refunds', {
      payment_intent: req.paymentRef,
      amount: Math.round(Number(req.amount) * 100).toString(),
      'metadata[refund_number]': req.refundNumber,
    });
    return { status: refund.status === 'succeeded' ? 'succeeded' : 'processing', providerRef: String(refund.id) };
  }
}

/**
 * telebirr H5 C2B needs a merchant app ID, short code and RSA keys from Ethio Telecom, and its
 * request signing must follow the merchant integration guide. Until those are on file it refuses clearly.
 */
class TelebirrProvider implements PaymentProvider {
  readonly name = 'telebirr';
  readonly label = 'telebirr';
  readonly supportsRefunds = false;
  async createCheckout(): Promise<CheckoutResult> {
    throw new ProviderError('telebirr direct integration needs merchant credentials; use Chapa (which accepts telebirr) meanwhile');
  }
  async refund(): Promise<RefundResult> {
    throw new ProviderError('telebirr refunds are not supported yet');
  }
}

const feeTable = new Map(
  env.PAYMENT_FEES_PCT.split(',')
    .map((p) => p.trim().split(':'))
    .filter((p) => p.length === 2)
    .map(([name, pct]) => [name!, Number(pct)]),
);

@Injectable()
export class PaymentProviders {
  private readonly logger = new Logger(PaymentProviders.name);
  private readonly providers = new Map<string, PaymentProvider>();

  constructor() {
    for (const name of env.PAYMENT_PROVIDERS.split(',').map((p) => p.trim()).filter(Boolean)) {
      const provider = this.build(name);
      if (provider) this.providers.set(name, provider);
      else this.logger.warn(`Payment provider "${name}" is enabled but not configured; skipping it`);
    }
  }

  private build(name: string): PaymentProvider | null {
    switch (name) {
      case 'manual':
        return new ManualProvider();
      case 'sandbox':
        return new SandboxProvider();
      case 'chapa':
        return env.CHAPA_SECRET_KEY ? new ChapaProvider(env.CHAPA_SECRET_KEY) : null;
      case 'stripe':
        return env.STRIPE_SECRET_KEY ? new StripeProvider(env.STRIPE_SECRET_KEY) : null;
      case 'telebirr':
        return new TelebirrProvider();
      default:
        return null;
    }
  }

  list() {
    return [...this.providers.values()].map((p) => ({ name: p.name, label: p.label, supportsRefunds: p.supportsRefunds, online: p.name !== 'manual' }));
  }

  get(name: string): PaymentProvider | null {
    return this.providers.get(name) ?? null;
  }

  /** Fee for a payment when the provider didn't report one. */
  feeFor(provider: string, amount: number) {
    const pct = feeTable.get(provider) ?? 0;
    return Math.round(amount * pct) / 100;
  }
}
