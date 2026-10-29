import { randomUUID } from 'node:crypto';

import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  type ActingOrganization,
  AppError,
  badRequest,
  conflict,
  emitEvent,
  forbidden,
  notFound,
  type PaginationQueryDto,
  qualified,
  requireApprovalLimit,
  requirePermission,
  requireRole,
  skipTake,
  toPage,
} from '@uboce/common';
import type { DomainEvent } from '@uboce/contracts';

import { env, SERVICE_NAME } from '../config.js';
import { Prisma } from '../generated/prisma/client.js';
import type { Refund } from '../generated/prisma/client.js';
import { outstanding, settlementStatus } from '../invoices/money.js';
import { PrismaService } from '../prisma.service.js';
import { PaymentProviders, ProviderError } from './providers.js';

type Tx = Prisma.TransactionClient;
const { Decimal } = Prisma;

const SELLER_FINANCE = ['owner', 'admin', 'finance_officer'];
const BUYER_PAYERS = ['owner', 'admin', 'finance_officer', 'procurement_officer'];
const READ_ROLES = ['owner', 'admin', 'finance_officer', 'procurement_officer', 'sales_representative', 'auditor'];
/** Records created by events, not by a person. */
export const SYSTEM_USER = '00000000-0000-0000-0000-000000000000';

const providerFailure = (error: unknown) =>
  error instanceof ProviderError ? new AppError(HttpStatus.BAD_GATEWAY, 'provider_error', error.message) : error;

/**
 * Online payments, refunds and settlements (PRD addendum 2.7). Money is only ever
 * marked received from a verified provider callback (or a seller confirming a transfer).
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: PaymentProviders,
  ) {}

  listProviders() {
    return this.providers.list();
  }

  // ---- Payment intents -------------------------------------------------------------------

  /** The buyer starts paying an invoice's outstanding amount with a provider. Older pending attempts are cancelled. */
  async pay(org: ActingOrganization, userId: string, invoiceId: string, providerName: string, payerEmail?: string) {
    requireRole(org, BUYER_PAYERS, 'pay invoices');
    const provider = this.providers.get(providerName);
    if (!provider) throw badRequest('unknown_provider', 'That payment method is not available');
    const inv = await this.prisma.invoice.findFirst({ where: { id: invoiceId, buyerOrganizationId: org.organization.id, status: { not: 'draft' } } });
    if (!inv) throw notFound('Invoice');
    if (!['issued', 'partially_paid'].includes(inv.status)) throw conflict('not_payable', `A ${inv.status} invoice is not payable`);
    const amount = outstanding(inv);
    if (!amount.gt(0)) throw conflict('nothing_due', 'Nothing is outstanding on this invoice');

    const id = randomUUID();
    const reference = `${inv.number}__${id.slice(0, 8)}`;
    let checkout;
    try {
      checkout = await provider.createCheckout({
        intentId: id,
        reference,
        invoiceNumber: inv.number,
        amount: amount.toFixed(2),
        currency: inv.currency,
        description: `Invoice ${inv.number}`,
        returnUrl: `${env.APP_BASE_URL}/invoices/${inv.id}?payment=${id}`,
        callbackUrl: `${env.PUBLIC_API_URL}/api/v1/integrations/callbacks/${provider.name}`,
        payerEmail,
      });
    } catch (error) {
      throw providerFailure(error);
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.paymentIntent.updateMany({ where: { invoiceId, status: 'pending' }, data: { status: 'cancelled' } });
      const intent = await tx.paymentIntent.create({
        data: {
          id,
          invoiceId,
          provider: provider.name,
          providerRef: checkout.providerRef ?? reference,
          amount,
          currency: inv.currency,
          checkoutUrl: checkout.checkoutUrl,
          createdByUserId: userId,
        },
      });
      return { ...intent, instructions: checkout.instructions ?? null };
    });
  }

  async intents(org: ActingOrganization, invoiceId: string) {
    requireRole(org, READ_ROLES, 'view payments');
    const inv = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, OR: [{ sellerOrganizationId: org.organization.id }, { buyerOrganizationId: org.organization.id }] },
    });
    if (!inv) throw notFound('Invoice');
    return this.prisma.paymentIntent.findMany({ where: { invoiceId }, orderBy: { createdAt: 'desc' } });
  }

  /** Buyer-facing read of one attempt (e.g. the sandbox checkout page). */
  async intent(org: ActingOrganization, intentId: string) {
    const intent = await this.prisma.paymentIntent.findFirst({
      where: { id: intentId, invoice: { OR: [{ buyerOrganizationId: org.organization.id }, { sellerOrganizationId: org.organization.id }] } },
      include: { invoice: { select: { number: true, sellerOrganizationId: true, buyerOrganizationId: true } } },
    });
    if (!intent) throw notFound('Payment');
    return intent;
  }

  /** Called with every provider payment callback (after Finance applies it to the invoice). */
  async onProviderPayment(tx: Tx, provider: string, reference: string, status: 'confirmed' | 'failed' | 'reversed', amount: Prisma.Decimal, fee?: string | null) {
    const intent = await tx.paymentIntent.findUnique({ where: { provider_providerRef: { provider, providerRef: reference } } });
    if (!intent || intent.status === 'succeeded' || intent.status === 'cancelled') return;
    if (status === 'confirmed') {
      const providerFee = fee ? new Decimal(fee) : new Decimal(this.providers.feeFor(provider, amount.toNumber()));
      await tx.paymentIntent.update({ where: { id: intent.id }, data: { status: 'succeeded', fee: providerFee } });
    } else if (status === 'failed') {
      await tx.paymentIntent.update({ where: { id: intent.id }, data: { status: 'failed', failureReason: 'declined by the provider' } });
    }
  }

  // ---- Refunds -------------------------------------------------------------------------------

  async listRefunds(org: ActingOrganization, side: 'seller' | 'buyer', query: PaginationQueryDto & { status?: string }) {
    requireRole(org, READ_ROLES, 'view refunds');
    const where: Prisma.RefundWhereInput = {
      [side === 'seller' ? 'sellerOrganizationId' : 'buyerOrganizationId']: org.organization.id,
      ...(query.status ? { status: query.status as Refund['status'] } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.refund.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(query) }),
      this.prisma.refund.count({ where }),
    ]);
    return toPage(items, total, query);
  }

  async getRefund(org: ActingOrganization, refundId: string) {
    requireRole(org, READ_ROLES, 'view refunds');
    const refund = await this.prisma.refund.findFirst({
      where: { id: refundId, OR: [{ sellerOrganizationId: org.organization.id }, { buyerOrganizationId: org.organization.id }] },
    });
    if (!refund) throw notFound('Refund');
    return refund;
  }

  /** A seller refunds part of a paid invoice on its own initiative (goodwill, overpayment). */
  async createRefund(org: ActingOrganization, userId: string, dto: { invoiceId: string; amount: string; reason: string }) {
    requireRole(org, SELLER_FINANCE, 'refund buyers');
    const inv = await this.prisma.invoice.findFirst({ where: { id: dto.invoiceId, sellerOrganizationId: org.organization.id } });
    if (!inv) throw notFound('Invoice');
    if (new Decimal(dto.amount).gt(inv.paidAmount)) throw badRequest('over_refund', `At most ${inv.paidAmount.toString()} has been paid`);
    return this.prisma.$transaction(async (tx) => {
      const refund = await tx.refund.create({
        data: {
          number: await this.nextNumber(tx),
          sellerOrganizationId: inv.sellerOrganizationId,
          buyerOrganizationId: inv.buyerOrganizationId,
          invoiceId: inv.id,
          orderId: inv.orderId,
          amount: dto.amount,
          currency: inv.currency,
          reason: dto.reason.trim(),
          requestedByUserId: userId,
        },
      });
      await this.announce(tx, refund);
      return refund;
    });
  }

  /** From Commerce: a return was received, so the buyer is owed its value. */
  async fromReturn(tx: Tx, e: DomainEvent<'ReturnStatusChanged'>) {
    const d = e.data;
    if (d.status !== 'received' || !new Decimal(d.refundAmount).gt(0)) return;
    if (await tx.refund.findUnique({ where: { returnId: d.returnId } })) return;
    const inv = await tx.invoice.findFirst({ where: { orderId: d.orderId, status: { not: 'void' } }, orderBy: { createdAt: 'desc' } });
    const refund = await tx.refund.create({
      data: {
        number: await this.nextNumber(tx),
        sellerOrganizationId: d.supplierOrganizationId,
        buyerOrganizationId: d.buyerOrganizationId,
        invoiceId: inv?.id ?? null,
        orderId: d.orderId,
        returnId: d.returnId,
        amount: d.refundAmount,
        currency: d.currency,
        reason: `Return for order ${d.orderNumber}`,
      },
    });
    await this.announce(tx, refund);
  }

  /**
   * The seller approves. With method "provider" the money goes back through the original
   * online payment; "manual" means the seller pays it back themselves and then marks it paid.
   * An unpaid invoice is simply credited.
   */
  async approveRefund(org: ActingOrganization, userId: string, refundId: string, method: 'provider' | 'manual') {
    requireRole(org, SELLER_FINANCE, 'approve refunds');
    requirePermission(org, 'refunds:approve', 'approve refunds');
    const refund = await this.prisma.refund.findFirst({ where: { id: refundId, sellerOrganizationId: org.organization.id } });
    if (!refund) throw notFound('Refund');
    if (refund.status !== 'requested') throw conflict('invalid_transition', `A ${refund.status} refund cannot be approved`);
    // Separation of duties: whoever asked for a refund can't approve it themselves.
    if (refund.requestedByUserId === userId) throw forbidden('Someone else must approve a refund you requested');
    requireApprovalLimit(org, refund.amount.toString(), refund.currency, 'approve refunds');
    const inv = refund.invoiceId ? await this.prisma.invoice.findUnique({ where: { id: refund.invoiceId } }) : null;

    // Nothing paid yet: reduce what is owed instead of sending money.
    if (inv && inv.paidAmount.lte(0)) {
      return this.prisma.$transaction(async (tx) => {
        await tx.refund.update({ where: { id: refund.id }, data: { status: 'approved', method: 'credit_note', approvedByUserId: userId } });
        return this.complete(tx, refund.id, userId, null);
      });
    }

    if (method === 'manual') {
      return this.prisma.$transaction(async (tx) => {
        const updated = await tx.refund.update({ where: { id: refund.id }, data: { status: 'processing', method: 'manual', approvedByUserId: userId } });
        await this.announce(tx, updated);
        return updated;
      });
    }

    const payment = inv
      ? await this.prisma.paymentIntent.findFirst({ where: { invoiceId: inv.id, status: 'succeeded' }, orderBy: { createdAt: 'desc' } })
      : null;
    const provider = payment ? this.providers.get(payment.provider) : null;
    if (!payment || !provider?.supportsRefunds) throw conflict('no_online_payment', 'There is no online payment to refund through; refund it manually');

    let result;
    try {
      result = await provider.refund({ refundNumber: refund.number, paymentRef: payment.providerRef, amount: refund.amount.toFixed(2), currency: refund.currency, reason: refund.reason });
    } catch (error) {
      await this.prisma.refund.update({ where: { id: refund.id }, data: { failureReason: (error as Error).message.slice(0, 300) } });
      throw providerFailure(error);
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.refund.update({
        where: { id: refund.id },
        data: { status: 'processing', method: 'provider', provider: provider.name, providerRef: result.providerRef, approvedByUserId: userId },
      });
      if (result.status === 'succeeded') return this.complete(tx, refund.id, userId, result.providerRef);
      await this.announce(tx, updated);
      return updated;
    });
  }

  async rejectRefund(org: ActingOrganization, userId: string, refundId: string, reason: string) {
    requireRole(org, SELLER_FINANCE, 'reject refunds');
    const refund = await this.prisma.refund.findFirst({ where: { id: refundId, sellerOrganizationId: org.organization.id } });
    if (!refund) throw notFound('Refund');
    if (refund.status !== 'requested') throw conflict('invalid_transition', `A ${refund.status} refund cannot be rejected`);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.refund.update({ where: { id: refund.id }, data: { status: 'rejected', failureReason: reason, approvedByUserId: userId } });
      await this.announce(tx, updated);
      return updated;
    });
  }

  /** The seller sent a manual refund (e.g. bank transfer) and records its reference. */
  async markRefundPaid(org: ActingOrganization, userId: string, refundId: string, reference: string) {
    requireRole(org, SELLER_FINANCE, 'record refunds');
    const refund = await this.prisma.refund.findFirst({ where: { id: refundId, sellerOrganizationId: org.organization.id } });
    if (!refund) throw notFound('Refund');
    if (refund.status !== 'processing' || refund.method !== 'manual') throw conflict('invalid_transition', 'Only approved manual refunds can be marked as paid');
    return this.prisma.$transaction((tx) => this.complete(tx, refund.id, userId, reference));
  }

  /** From Integration: the provider finished (or failed) a refund. Idempotent. */
  async refundNotification(n: { provider: string; refundNumber: string; status: 'succeeded' | 'failed'; providerRef?: string; reason?: string }) {
    const refund = await this.prisma.refund.findUnique({ where: { number: n.refundNumber } });
    if (!refund) throw notFound('Refund');
    if (refund.provider !== n.provider) throw conflict('provider_mismatch', 'This refund was sent through another provider');
    if (refund.status !== 'processing') return { applied: false };
    return this.prisma.$transaction(async (tx) => {
      if (n.status === 'succeeded') await this.complete(tx, refund.id, SYSTEM_USER, n.providerRef ?? refund.providerRef);
      else {
        const failed = await tx.refund.update({ where: { id: refund.id }, data: { status: 'failed', failureReason: n.reason ?? 'the provider could not refund' } });
        await this.announce(tx, failed);
      }
      return { applied: true };
    });
  }

  /**
   * Books a finished refund: a credit note reduces what the invoice says is owed, and (when
   * money actually went back) a negative payment reduces what it says was paid.
   */
  private async complete(tx: Tx, refundId: string, userId: string, providerRef: string | null) {
    const refund = await tx.refund.update({ where: { id: refundId }, data: { status: 'succeeded', providerRef: providerRef ?? undefined } });
    if (refund.invoiceId) {
      const year = new Date().getUTCFullYear();
      const [row] = await tx.$queryRaw<{ last: number }[]>`
        INSERT INTO ${Prisma.raw(qualified('document_counters'))} (key, last) VALUES (${`CN-${year}`}, 1)
        ON CONFLICT (key) DO UPDATE SET last = document_counters.last + 1 RETURNING last`;
      await tx.creditNote.create({
        data: { invoiceId: refund.invoiceId, number: `CN-${year}-${String(row!.last).padStart(6, '0')}`, amount: refund.amount, reason: `Refund ${refund.number}: ${refund.reason}`, createdByUserId: userId },
      });
      let inv = await tx.invoice.update({ where: { id: refund.invoiceId }, data: { creditedAmount: { increment: refund.amount } } });
      if (refund.method !== 'credit_note') {
        const payment = await tx.paymentReference.create({
          data: {
            invoiceId: refund.invoiceId,
            provider: refund.provider ?? 'manual_refund',
            externalReference: `refund:${refund.number}`,
            amount: refund.amount.negated(),
            currency: refund.currency,
            status: 'confirmed',
            source: 'refund',
            recordedByUserId: userId === SYSTEM_USER ? null : userId,
            occurredAt: new Date(),
          },
        });
        await tx.reconciliation.create({ data: { invoiceId: refund.invoiceId, paymentReferenceId: payment.id, appliedAmount: refund.amount.negated(), note: `refund ${refund.number}` } });
        inv = await tx.invoice.update({ where: { id: refund.invoiceId }, data: { paidAmount: { decrement: refund.amount } } });
      }
      if (inv.status !== 'disputed' && inv.status !== 'void' && inv.status !== 'draft') {
        const status = settlementStatus(inv);
        if (status !== inv.status) await tx.invoice.update({ where: { id: inv.id }, data: { status } });
      }
    }
    await this.announce(tx, refund);
    return refund;
  }

  private announce(tx: Tx, r: Refund) {
    return emitEvent(tx, SERVICE_NAME, 'RefundStatusChanged', r.id, {
      refundId: r.id,
      orderId: r.orderId,
      invoiceId: r.invoiceId,
      returnId: r.returnId,
      sellerOrganizationId: r.sellerOrganizationId,
      buyerOrganizationId: r.buyerOrganizationId,
      status: r.status,
      amount: r.amount.toString(),
      currency: r.currency,
      provider: r.provider,
    });
  }

  // ---- Fees from Commerce ---------------------------------------------------------------------

  /** A cancellation or no-show fee becomes a draft invoice the seller reviews and issues. */
  async feeInvoice(tx: Tx, e: DomainEvent<'OrderChargeAssessed'>) {
    const d = e.data;
    const marker = `${d.kind}:${d.orderId}`;
    if (await tx.invoice.findFirst({ where: { notes: { startsWith: marker } } })) return;
    const year = new Date().getUTCFullYear();
    const [row] = await tx.$queryRaw<{ last: number }[]>`
      INSERT INTO ${Prisma.raw(qualified('document_counters'))} (key, last) VALUES (${`INV-${year}`}, 1)
      ON CONFLICT (key) DO UPDATE SET last = document_counters.last + 1 RETURNING last`;
    const label = d.kind === 'cancellation_fee' ? 'Late cancellation fee' : 'Uncollected order (no-show) fee';
    await tx.invoice.create({
      data: {
        number: `INV-${year}-${String(row!.last).padStart(6, '0')}`,
        sellerOrganizationId: d.supplierOrganizationId,
        buyerOrganizationId: d.buyerOrganizationId,
        orderId: d.orderId,
        currency: d.currency,
        subtotal: d.amount,
        taxTotal: 0,
        total: d.amount,
        dueDate: new Date(Date.now() + 14 * 86_400_000),
        notes: `${marker} — ${label} for order ${d.orderNumber}${d.policyVersion ? ` (policy v${d.policyVersion})` : ''}`,
        createdByUserId: SYSTEM_USER,
        lines: {
          create: [{ lineNumber: 1, description: `${label} — order ${d.orderNumber}`, quantity: 1, unitPrice: d.amount, taxRatePct: 0, subtotal: d.amount, tax: 0, total: d.amount }],
        },
      },
    });
  }

  // ---- Settlements ---------------------------------------------------------------------------

  async listSettlements(org: ActingOrganization, query: PaginationQueryDto) {
    requireRole(org, [...SELLER_FINANCE, 'auditor'], 'view settlements');
    const where = { sellerOrganizationId: org.organization.id };
    const [items, total] = await Promise.all([
      this.prisma.settlement.findMany({ where, orderBy: { periodEnd: 'desc' }, ...skipTake(query) }),
      this.prisma.settlement.count({ where }),
    ]);
    return toPage(items, total, query);
  }

  /** Reconciliation run: what a provider should pay out for a period, from the payments and refunds we recorded. */
  async runSettlement(org: ActingOrganization, userId: string, dto: { provider: string; currency: string; from: string; to: string }) {
    requireRole(org, SELLER_FINANCE, 'reconcile settlements');
    const periodStart = new Date(dto.from);
    const periodEnd = new Date(dto.to);
    if (periodStart >= periodEnd) throw badRequest('invalid_period', 'The period must end after it starts');
    const sellerOrganizationId = org.organization.id;
    const payments = await this.prisma.paymentIntent.findMany({
      where: { provider: dto.provider, currency: dto.currency, status: 'succeeded', updatedAt: { gte: periodStart, lt: periodEnd }, invoice: { sellerOrganizationId } },
    });
    const refunds = await this.prisma.refund.findMany({
      where: { provider: dto.provider, currency: dto.currency, status: 'succeeded', updatedAt: { gte: periodStart, lt: periodEnd }, sellerOrganizationId },
    });
    const sum = (xs: Prisma.Decimal[]) => xs.reduce((s, x) => s.plus(x), new Decimal(0));
    const gross = sum(payments.map((p) => p.amount));
    const fees = sum(payments.map((p) => p.fee ?? new Decimal(0)));
    const refunded = sum(refunds.map((r) => r.amount));
    try {
      return await this.prisma.settlement.create({
        data: {
          sellerOrganizationId,
          provider: dto.provider,
          currency: dto.currency,
          periodStart,
          periodEnd,
          paymentCount: payments.length,
          grossAmount: gross,
          feeTotal: fees,
          refundTotal: refunded,
          netAmount: gross.minus(fees).minus(refunded),
          createdByUserId: userId,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw conflict('already_settled', 'This period was already reconciled');
      throw error;
    }
  }

  async markSettlementPaid(org: ActingOrganization, settlementId: string, payoutRef: string) {
    requireRole(org, SELLER_FINANCE, 'reconcile settlements');
    const s = await this.prisma.settlement.findFirst({ where: { id: settlementId, sellerOrganizationId: org.organization.id } });
    if (!s) throw notFound('Settlement');
    if (s.status === 'paid') return s;
    return this.prisma.settlement.update({ where: { id: s.id }, data: { status: 'paid', payoutRef, paidAt: new Date() } });
  }

  /** RF-<year>-<6 digits>. */
  private async nextNumber(tx: Tx) {
    const key = `RF-${new Date().getUTCFullYear()}`;
    const [row] = await tx.$queryRaw<{ last: number }[]>`
      INSERT INTO ${Prisma.raw(qualified('document_counters'))} (key, last) VALUES (${key}, 1)
      ON CONFLICT (key) DO UPDATE SET last = document_counters.last + 1 RETURNING last`;
    return `${key}-${String(row!.last).padStart(6, '0')}`;
  }
}
