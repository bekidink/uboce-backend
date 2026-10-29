import { createHash } from 'node:crypto';

import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppError, FinanceClient, InternalCallError, LogisticsClient } from '@uboce/common';
import { z } from 'zod';

import { env, providers } from '../config.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma.service.js';
import { verifyChapaSignature, verifySignature } from './signature.js';

// The normalized payloads providers send (or adapters translate to).
const paymentSchema = z.object({
  eventId: z.string().min(1).max(200),
  type: z.enum(['payment.confirmed', 'payment.failed', 'payment.reversed']),
  reference: z.string().min(1).max(200),
  invoiceNumber: z.string().min(5).max(50),
  amount: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  fee: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/).optional(),
  occurredAt: z.string().datetime(),
});

/** Refund outcomes, from the same payment providers (PRD addendum 2.7). */
const refundSchema = z.object({
  eventId: z.string().min(1).max(200),
  type: z.enum(['refund.succeeded', 'refund.failed']),
  refundNumber: z.string().min(5).max(50),
  providerRef: z.string().max(200).optional(),
  reason: z.string().max(300).optional(),
  occurredAt: z.string().datetime(),
});

/**
 * Chapa's own webhook body, translated to the normalized payment event. Our tx_ref is
 * "<invoice number>__<intent>", so the invoice is known without a lookup.
 */
const chapaSchema = z.object({
  tx_ref: z.string().min(5).max(200),
  status: z.string(),
  amount: z.union([z.string(), z.number()]),
  currency: z.string().regex(/^[A-Z]{3}$/),
  charge: z.union([z.string(), z.number()]).optional(),
  reference: z.string().optional(),
  created_at: z.string().optional(),
});

export function fromChapa(body: unknown): z.infer<typeof paymentSchema> | null {
  const c = chapaSchema.safeParse(body);
  if (!c.success) return null;
  const invoiceNumber = c.data.tx_ref.split('__')[0]!;
  const status = c.data.status.toLowerCase();
  return {
    eventId: `chapa:${c.data.tx_ref}:${status}`,
    type: status === 'success' ? 'payment.confirmed' : status === 'reversed' || status === 'refunded' ? 'payment.reversed' : 'payment.failed',
    reference: c.data.tx_ref,
    invoiceNumber,
    amount: Number(c.data.amount).toFixed(2),
    currency: c.data.currency,
    fee: c.data.charge !== undefined ? Number(c.data.charge).toFixed(2) : undefined,
    occurredAt: c.data.created_at ? new Date(c.data.created_at).toISOString() : new Date().toISOString(),
  };
}

const carrierSchema = z.object({
  eventId: z.string().min(1).max(200),
  trackingNumber: z.string().min(3).max(100),
  status: z.enum(['in_transit', 'delivered', 'failed', 'returned']),
  location: z.string().max(200).optional(),
  occurredAt: z.string().datetime(),
});

const reject = (message: string, code = 'invalid_callback') => new AppError(HttpStatus.UNAUTHORIZED, code, message);

@Injectable()
export class CallbacksService {
  private readonly logger = new Logger(CallbacksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly finance: FinanceClient,
    private readonly logistics: LogisticsClient,
  ) {}

  /**
   * Verifies, deduplicates and forwards one provider callback. A failure to
   * forward returns 502 so the provider retries; a duplicate returns 200 so it stops.
   */
  async handle(providerName: string, headers: { timestamp?: string; signature?: string; chapaSignature?: string }, rawBody: Buffer | undefined) {
    const provider = providers.get(providerName);
    if (!provider) throw reject('Unknown provider', 'unknown_provider');
    const body = rawBody ?? Buffer.alloc(0);
    const payloadSha256 = createHash('sha256').update(body).digest('hex');

    const check =
      provider.kind === 'chapa'
        ? verifyChapaSignature(provider.secret, headers.chapaSignature, body)
        : verifySignature(provider.secret, headers.timestamp, headers.signature, body, env.CALLBACK_MAX_AGE_SECONDS);
    if (!check.ok) {
      await this.receipt(provider.name, null, false, 'rejected', `signature ${check.reason}`, payloadSha256);
      throw reject(`Signature ${check.reason}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      await this.receipt(provider.name, null, true, 'rejected', 'invalid JSON', payloadSha256);
      throw new AppError(HttpStatus.BAD_REQUEST, 'invalid_payload', 'Body is not JSON');
    }
    // Refund callbacks share the payment provider's secret; Chapa sends its own format.
    const isRefund = provider.kind === 'payment' && typeof (parsed as { type?: unknown })?.type === 'string' && String((parsed as { type: string }).type).startsWith('refund.');
    const normalized = provider.kind === 'chapa' ? fromChapa(parsed) : parsed;
    const schema = isRefund ? refundSchema : provider.kind === 'carrier' ? carrierSchema : paymentSchema;
    const result = normalized ? schema.safeParse(normalized) : ({ success: false } as const);
    if (!result.success) {
      await this.receipt(provider.name, null, true, 'rejected', 'payload does not match the contract', payloadSha256);
      throw new AppError(HttpStatus.BAD_REQUEST, 'invalid_payload', 'Payload does not match the expected format');
    }
    const eventId = result.data.eventId;

    // Claim the event ID first: a concurrent or repeated delivery stops here.
    const claimed = await this.claim(provider.name, eventId, payloadSha256);
    if (!claimed) return { status: 'duplicate' };

    try {
      if (isRefund) {
        const r = result.data as z.infer<typeof refundSchema>;
        await this.finance.refundNotification({
          provider: provider.name,
          refundNumber: r.refundNumber,
          status: r.type === 'refund.succeeded' ? 'succeeded' : 'failed',
          providerRef: r.providerRef,
          reason: r.reason,
        });
      } else if (provider.kind === 'payment' || provider.kind === 'chapa') {
        const p = result.data as z.infer<typeof paymentSchema>;
        await this.finance.paymentNotification({
          fee: p.fee ?? null,
          provider: provider.name,
          externalReference: p.reference,
          invoiceNumber: p.invoiceNumber,
          amount: p.amount,
          currency: p.currency,
          status: p.type.replace('payment.', '') as 'confirmed' | 'failed' | 'reversed',
          occurredAt: p.occurredAt,
        });
      } else {
        const c = result.data as z.infer<typeof carrierSchema>;
        await this.logistics.trackingEvent({ provider: provider.name, externalEventId: c.eventId, trackingNumber: c.trackingNumber, status: c.status, location: c.location, occurredAt: c.occurredAt });
      }
      await this.prisma.callbackReceipt.update({ where: { provider_externalEventId: { provider: provider.name, externalEventId: eventId } }, data: { outcome: 'processed' } });
      return { status: 'processed' };
    } catch (error) {
      // 4xx from the core service means the callback can never succeed (e.g. unknown invoice): keep it, don't retry.
      const permanent = error instanceof InternalCallError && error.status < 500;
      const message = error instanceof InternalCallError ? JSON.stringify(error.body).slice(0, 300) : String(error).slice(0, 300);
      if (permanent) {
        await this.prisma.callbackReceipt.update({ where: { provider_externalEventId: { provider: provider.name, externalEventId: eventId } }, data: { outcome: 'rejected', error: message } });
        throw new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'callback_not_applicable', 'The callback refers to something that cannot be applied');
      }
      // Release the claim so the provider's retry is processed.
      await this.prisma.callbackReceipt.delete({ where: { provider_externalEventId: { provider: provider.name, externalEventId: eventId } } });
      await this.receipt(provider.name, null, true, 'failed', message, payloadSha256);
      this.logger.error(`Forwarding ${provider.name} ${eventId} failed: ${message}`);
      throw new AppError(HttpStatus.BAD_GATEWAY, 'temporarily_unavailable', 'Try again later');
    }
  }

  /** Integration health per provider (PRD 5.19): recent outcomes. */
  async health(sinceHours = 24) {
    const since = new Date(Date.now() - sinceHours * 3_600_000);
    const rows = await this.prisma.callbackReceipt.groupBy({ by: ['provider', 'outcome'], where: { receivedAt: { gte: since } }, _count: true });
    const byProvider: Record<string, Record<string, number>> = {};
    for (const name of providers.keys()) byProvider[name] = {};
    for (const r of rows) (byProvider[r.provider] ??= {})[r.outcome] = r._count;
    return { windowHours: sinceHours, providers: byProvider };
  }

  private async claim(provider: string, externalEventId: string, payloadSha256: string) {
    try {
      await this.prisma.callbackReceipt.create({ data: { provider, externalEventId, signatureValid: true, outcome: 'processing', payloadSha256 } });
      return true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        await this.receipt(provider, null, true, 'duplicate', `duplicate of ${externalEventId}`, payloadSha256);
        return false;
      }
      throw error;
    }
  }

  private receipt(provider: string, externalEventId: string | null, signatureValid: boolean, outcome: string, error: string | null, payloadSha256: string) {
    return this.prisma.callbackReceipt.create({ data: { provider, externalEventId, signatureValid, outcome, error, payloadSha256 } });
  }
}
