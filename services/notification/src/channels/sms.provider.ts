import { Logger } from '@nestjs/common';
import { maskPhone } from '@uboce/common';

export const SMS_PROVIDER = Symbol('SMS_PROVIDER');

export interface SmsResult {
  /** The provider's ID, quoted again on its delivery receipt. */
  messageId: string | null;
  /** Billable parts: 160 GSM-7 characters each, or 70 for Amharic (UCS-2). */
  segments: number;
}

export interface SmsProvider {
  readonly name: string;
  send(to: string, text: string): Promise<SmsResult>;
}

const GSM_EXTRA = new Set('£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉÄÖÑÜ§¿äöñüà€');

/** How many SMS parts a text costs. Ethiopic script forces UCS-2. */
export function smsSegments(text: string) {
  const chars = [...text];
  const gsm = chars.every((c) => c.charCodeAt(0) < 128 || GSM_EXTRA.has(c));
  const single = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;
  return chars.length <= single ? 1 : Math.ceil(chars.length / multi);
}

/** Development and tests: nothing leaves the machine. */
export class LogSmsProvider implements SmsProvider {
  readonly name = 'log';
  private readonly logger = new Logger('LogSmsProvider');

  async send(to: string, text: string) {
    this.logger.log(`SMS to ${maskPhone(to)} (${smsSegments(text)} part(s))`);
    return { messageId: null, segments: smsSegments(text) };
  }
}

export class SmsProviderError extends Error {}

/**
 * AfroMessage (afromessage.com), an Ethiopian SMS gateway. Needs an API token,
 * and optionally a registered identifier (`from`) and sender name. Delivery
 * receipts arrive at the callback URL.
 */
export class AfroMessageSmsProvider implements SmsProvider {
  readonly name = 'afromessage';

  constructor(private readonly options: { token: string; identifierId?: string; sender?: string; callbackUrl?: string; apiUrl: string }) {}

  async send(to: string, text: string) {
    const body = {
      to,
      message: text,
      ...(this.options.identifierId ? { from: this.options.identifierId } : {}),
      ...(this.options.sender ? { sender: this.options.sender } : {}),
      ...(this.options.callbackUrl ? { callback: this.options.callbackUrl } : {}),
    };
    const res = await fetch(`${this.options.apiUrl.replace(/\/$/, '')}/send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.options.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const out = (await res.json().catch(() => null)) as { acknowledge?: string; response?: { message_id?: string } } | null;
    if (!res.ok || out?.acknowledge !== 'success') throw new SmsProviderError(`AfroMessage refused the message (${res.status})`);
    return { messageId: out.response?.message_id ? String(out.response.message_id) : null, segments: smsSegments(text) };
  }
}

/**
 * Any HTTP gateway that accepts `{ to, message, sender, callbackUrl }` as JSON
 * with a bearer token and answers with `{ id }` or `{ messageId }`. Lets a
 * provider be swapped without code (PRD v2 NTF-02: adapters).
 */
export class HttpSmsProvider implements SmsProvider {
  readonly name = 'http';

  constructor(private readonly options: { url: string; token?: string; sender?: string; callbackUrl?: string }) {}

  async send(to: string, text: string) {
    const res = await fetch(this.options.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}) },
      body: JSON.stringify({ to, message: text, sender: this.options.sender, callbackUrl: this.options.callbackUrl }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new SmsProviderError(`SMS gateway answered ${res.status}`);
    const out = (await res.json().catch(() => ({}))) as { id?: string; messageId?: string };
    return { messageId: out.messageId ?? out.id ?? null, segments: smsSegments(text) };
  }
}

/** Maps the many spellings gateways use for delivery states. */
export function receiptStatus(raw: string | undefined | null): 'delivered' | 'failed' | null {
  const s = (raw ?? '').toLowerCase();
  if (['delivered', 'delivrd', 'success', 'sent_to_handset'].includes(s)) return 'delivered';
  if (['failed', 'undelivered', 'undeliv', 'rejected', 'expired', 'rejectd', 'error'].includes(s)) return 'failed';
  return null;
}
