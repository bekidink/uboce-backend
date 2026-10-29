import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type ActingOrganization,
  AppError,
  badRequest,
  CommerceClient,
  conflict,
  emitEvent,
  notFound,
  OrganizationsClient,
  type PaginationQueryDto,
  requireRole,
  skipTake,
  toPage,
  qualified,
} from '@uboce/common';
import type { PaymentNotification } from '@uboce/contracts';

import { SERVICE_NAME } from '../config.js';
import { Prisma } from '../generated/prisma/client.js';
import type { InvoiceStatus } from '../generated/prisma/enums.js';
import { PaymentsService } from '../payments/payments.service.js';
import { PrismaService } from '../prisma.service.js';
import { type LineInput, outstanding, priceLines, settlementStatus } from './money.js';

const { Decimal } = Prisma;
type Tx = Prisma.TransactionClient;

const SELLER_ROLES = ['owner', 'admin', 'finance_officer', 'sales_representative'];
const BUYER_ROLES = ['owner', 'admin', 'finance_officer', 'procurement_officer'];
const READ_ROLES = [...new Set([...SELLER_ROLES, ...BUYER_ROLES, 'auditor'])];
const include = { lines: { orderBy: { lineNumber: 'asc' } }, payments: { orderBy: { createdAt: 'asc' } }, creditNotes: true } as const;
type FullInvoice = Prisma.InvoiceGetPayload<{ include: typeof include }>;

const view = (inv: FullInvoice) => ({ ...inv, outstanding: outstanding(inv).toString() });

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commerce: CommerceClient,
    private readonly organizations: OrganizationsClient,
    private readonly payments: PaymentsService,
  ) {}

  /** Draft from an order's immutable lines (seller side). */
  async fromOrder(org: ActingOrganization, userId: string, dto: { orderId: string; taxRatePct: string; dueInDays: number; notes?: string }) {
    requireRole(org, SELLER_ROLES, 'invoice orders');
    const order = await this.commerce.getOrder(dto.orderId);
    if (!order || order.supplierOrganizationId !== org.organization.id) throw notFound('Order');
    if (['pending_confirmation', 'cancelled'].includes(order.status)) throw conflict('order_not_invoiceable', `A ${order.status} order cannot be invoiced`);
    const live = await this.prisma.invoice.count({ where: { orderId: order.id, status: { not: 'void' } } });
    if (live > 0) throw conflict('already_invoiced', 'This order already has an invoice; void it or use a credit note');
    return this.draft(org, userId, {
      buyerOrganizationId: order.buyerOrganizationId,
      orderId: order.id,
      currency: order.currency,
      dueInDays: dto.dueInDays,
      notes: dto.notes,
      lines: [
        ...order.lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, taxRatePct: dto.taxRatePct, orderLineId: l.id })),
        // Promotions reduce the taxable amount, so the discount is a negative line taxed at the same rate.
        ...(Number(order.discountTotal ?? 0) > 0
          ? [{ description: `Discount${order.promotionCode ? ` (${order.promotionCode})` : ''}`, quantity: '1', unitPrice: `-${order.discountTotal}`, taxRatePct: dto.taxRatePct }]
          : []),
      ],
    });
  }

  async manual(org: ActingOrganization, userId: string, dto: { buyerOrganizationId: string; currency: string; dueInDays: number; notes?: string; lines: LineInput[] }) {
    requireRole(org, SELLER_ROLES, 'create invoices');
    if (dto.buyerOrganizationId === org.organization.id) throw badRequest('self_invoice', 'You cannot invoice your own organization');
    const buyer = await this.organizations.getOrganization(dto.buyerOrganizationId);
    if (!buyer || buyer.status !== 'active') throw badRequest('unknown_buyer', 'Buyer does not exist or is inactive');
    return this.draft(org, userId, dto);
  }

  async issue(org: ActingOrganization, invoiceId: string) {
    requireRole(org, SELLER_ROLES, 'issue invoices');
    const inv = await this.owned(org, invoiceId, 'seller');
    if (inv.status !== 'draft') throw conflict('invalid_transition', `A ${inv.status} invoice cannot be issued`);
    return this.prisma.$transaction(async (tx) => {
      await tx.invoice.update({ where: { id: invoiceId }, data: { status: 'issued', issuedAt: new Date() } });
      await emitEvent(tx, SERVICE_NAME, 'InvoiceIssued', invoiceId, {
        invoiceId,
        invoiceNumber: inv.number,
        orderId: inv.orderId,
        sellerOrganizationId: inv.sellerOrganizationId,
        buyerOrganizationId: inv.buyerOrganizationId,
        total: inv.total.toString(),
        currency: inv.currency,
        dueDate: inv.dueDate.toISOString(),
      });
      return view(await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include }));
    });
  }

  /** Only unpaid invoices can be voided; paid ones are corrected with credit notes. */
  async void(org: ActingOrganization, invoiceId: string, reason: string) {
    requireRole(org, SELLER_ROLES, 'void invoices');
    const inv = await this.owned(org, invoiceId, 'seller');
    if (!['draft', 'issued'].includes(inv.status) || inv.paidAmount.greaterThan(0)) {
      throw conflict('cannot_void', 'Only unpaid draft or issued invoices can be voided; use a credit note');
    }
    await this.prisma.invoice.update({ where: { id: invoiceId }, data: { status: 'void', voidedAt: new Date(), voidReason: reason } });
    return view(await this.owned(org, invoiceId, 'seller'));
  }

  async creditNote(org: ActingOrganization, userId: string, invoiceId: string, amount: string, reason: string) {
    requireRole(org, SELLER_ROLES, 'issue credit notes');
    const inv = await this.owned(org, invoiceId, 'seller');
    if (!['issued', 'partially_paid'].includes(inv.status)) throw conflict('invalid_state', `Cannot credit a ${inv.status} invoice`);
    if (new Decimal(amount).greaterThan(outstanding(inv))) throw badRequest('over_credit', `At most ${outstanding(inv).toString()} is outstanding`);
    return this.prisma.$transaction(async (tx) => {
      const number = await this.nextNumber(tx, 'CN');
      await tx.creditNote.create({ data: { invoiceId, number, amount, reason, createdByUserId: userId } });
      const updated = await tx.invoice.update({ where: { id: invoiceId }, data: { creditedAmount: { increment: amount } }, include });
      return view(await this.settle(tx, updated));
    });
  }

  /** The buyer reports a payment (e.g. a bank transfer reference). Recorded, but not proof: nothing is marked paid. */
  async claimPayment(org: ActingOrganization, userId: string, invoiceId: string, dto: { provider: string; externalReference: string; amount: string; paidAt: string }) {
    requireRole(org, BUYER_ROLES, 'report payments');
    const inv = await this.owned(org, invoiceId, 'buyer');
    if (!['issued', 'partially_paid', 'disputed'].includes(inv.status)) throw conflict('not_payable', `A ${inv.status} invoice is not payable`);
    try {
      await this.prisma.paymentReference.create({
        data: {
          invoiceId,
          provider: dto.provider,
          externalReference: dto.externalReference,
          amount: dto.amount,
          currency: inv.currency,
          status: 'pending',
          source: 'buyer_claim',
          recordedByUserId: userId,
          occurredAt: new Date(dto.paidAt),
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw conflict('reference_exists', 'That payment reference is already recorded');
      throw error;
    }
    return view(await this.owned(org, invoiceId, 'buyer'));
  }

  /** The seller confirms money it actually received (e.g. a claimed bank transfer). */
  async confirmPayment(org: ActingOrganization, userId: string, invoiceId: string, paymentId: string) {
    requireRole(org, ['owner', 'admin', 'finance_officer'], 'confirm payments');
    await this.owned(org, invoiceId, 'seller');
    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.paymentReference.findFirst({ where: { id: paymentId, invoiceId } });
      if (!payment) throw notFound('Payment');
      if (payment.status !== 'pending') throw conflict('not_pending', `This payment is already ${payment.status}`);
      await tx.paymentReference.update({ where: { id: paymentId }, data: { status: 'confirmed', source: 'seller_confirmation', recordedByUserId: userId } });
      return view(await this.apply(tx, invoiceId, paymentId, payment.amount, 'confirmed by seller'));
    });
  }

  /**
   * Provider callbacks (already verified by Integration). Idempotent on
   * (provider, reference): duplicates and late retries change nothing (PRD 8.5).
   */
  async providerNotification(n: PaymentNotification) {
    const inv = await this.prisma.invoice.findUnique({ where: { number: n.invoiceNumber } });
    if (!inv) throw notFound('Invoice');
    if (n.currency !== inv.currency) throw new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'currency_mismatch', 'Payment currency differs from the invoice');

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.paymentReference.findUnique({
        where: { provider_externalReference: { provider: n.provider, externalReference: n.externalReference } },
      });

      if (!existing) {
        const payment = await tx.paymentReference.create({
          data: {
            invoiceId: inv.id,
            provider: n.provider,
            externalReference: n.externalReference,
            amount: n.amount,
            currency: n.currency,
            status: n.status,
            source: 'provider_callback',
            occurredAt: new Date(n.occurredAt),
          },
        });
        // A reversal for a payment we never saw confirmed is recorded but moves no money.
        if (n.status === 'confirmed') await this.apply(tx, inv.id, payment.id, payment.amount, 'provider confirmed');
        await this.payments.onProviderPayment(tx, n.provider, n.externalReference, n.status, payment.amount, n.fee);
        return { applied: n.status === 'confirmed' };
      }

      // A provider reference identifies one payment for one invoice; reuse elsewhere is an error, not a duplicate.
      if (existing.invoiceId !== inv.id) {
        throw new AppError(HttpStatus.CONFLICT, 'reference_conflict', 'This provider reference belongs to another invoice');
      }

      // pending/failed → confirmed adds money; confirmed → reversed takes it back; pending → failed records it.
      if (n.status === 'confirmed' && (existing.status === 'pending' || existing.status === 'failed')) {
        await tx.paymentReference.update({ where: { id: existing.id }, data: { status: 'confirmed', source: 'provider_callback' } });
        await this.apply(tx, inv.id, existing.id, existing.amount, 'provider confirmed');
      } else if (n.status === 'reversed' && existing.status === 'confirmed') {
        await tx.paymentReference.update({ where: { id: existing.id }, data: { status: 'reversed' } });
        await this.apply(tx, inv.id, existing.id, existing.amount.negated(), 'provider reversed');
      } else if (n.status === 'failed' && existing.status === 'pending') {
        await tx.paymentReference.update({ where: { id: existing.id }, data: { status: 'failed' } });
      } else {
        return { applied: false }; // duplicate or out-of-order callback: no effect
      }
      await this.payments.onProviderPayment(tx, n.provider, n.externalReference, n.status, existing.amount, n.fee);
      return { applied: true };
    });
  }

  // ---- Disputes ------------------------------------------------------------------

  async markDisputed(tx: Tx, invoiceId: string) {
    const inv = await tx.invoice.findUnique({ where: { id: invoiceId } });
    if (!inv || inv.status === 'disputed' || inv.status === 'void' || inv.status === 'draft') return;
    await tx.invoice.update({ where: { id: invoiceId }, data: { status: 'disputed', statusBeforeDispute: inv.status } });
  }

  async clearDispute(tx: Tx, invoiceId: string) {
    const inv = await tx.invoice.findUnique({ where: { id: invoiceId }, include });
    if (!inv || inv.status !== 'disputed') return;
    await tx.invoice.update({ where: { id: invoiceId }, data: { status: settlementStatus(inv), statusBeforeDispute: null } });
  }

  // ---- Queries --------------------------------------------------------------------

  async list(org: ActingOrganization, side: 'seller' | 'buyer', status: InvoiceStatus | undefined, query: PaginationQueryDto) {
    requireRole(org, READ_ROLES, 'view invoices');
    const where: Prisma.InvoiceWhereInput = {
      [side === 'seller' ? 'sellerOrganizationId' : 'buyerOrganizationId']: org.organization.id,
      ...(side === 'buyer' ? { status: { not: 'draft' } } : {}),
      ...(status ? { status } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.invoice.findMany({ where, include, orderBy: { createdAt: 'desc' }, ...skipTake(query) }),
      this.prisma.invoice.count({ where }),
    ]);
    return toPage(items.map(view), total, query);
  }

  async get(org: ActingOrganization, invoiceId: string) {
    requireRole(org, READ_ROLES, 'view invoices');
    const inv = await this.prisma.invoice.findFirst({
      where: {
        id: invoiceId,
        OR: [{ sellerOrganizationId: org.organization.id }, { buyerOrganizationId: org.organization.id, status: { not: 'draft' } }],
      },
      include: { ...include, payments: { include: { reconciliations: true }, orderBy: { createdAt: 'asc' } } },
    });
    if (!inv) throw notFound('Invoice');
    return { ...inv, outstanding: outstanding(inv).toString() };
  }

  // ---- Internals --------------------------------------------------------------------

  private async draft(
    org: ActingOrganization,
    userId: string,
    dto: { buyerOrganizationId: string; orderId?: string; currency: string; dueInDays: number; notes?: string; lines: (LineInput & { orderLineId?: string })[] },
  ) {
    const priced = priceLines(dto.lines);
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.invoice.create({
        data: {
          number: await this.nextNumber(tx, 'INV'),
          sellerOrganizationId: org.organization.id,
          buyerOrganizationId: dto.buyerOrganizationId,
          orderId: dto.orderId,
          currency: dto.currency,
          subtotal: priced.subtotal,
          taxTotal: priced.taxTotal,
          total: priced.total,
          dueDate: new Date(Date.now() + dto.dueInDays * 86_400_000),
          notes: dto.notes,
          createdByUserId: userId,
          lines: {
            create: priced.lines.map((l, i) => ({
              lineNumber: i + 1,
              orderLineId: dto.lines[i]!.orderLineId,
              description: l.description,
              quantity: l.quantity,
              unitPrice: l.unitPrice,
              taxRatePct: l.taxRatePct,
              subtotal: l.subtotal,
              tax: l.tax,
              total: l.total,
            })),
          },
        },
        include,
      });
      return view(created);
    });
  }

  private async apply(tx: Tx, invoiceId: string, paymentId: string, amount: Prisma.Decimal, note: string) {
    await tx.reconciliation.create({ data: { invoiceId, paymentReferenceId: paymentId, appliedAmount: amount, note } });
    const updated = await tx.invoice.update({ where: { id: invoiceId }, data: { paidAmount: { increment: amount } }, include });
    return this.settle(tx, updated);
  }

  /** Recomputes paid status (unless disputed) and announces it (PRD 6.3: reconciled independently of delivery). */
  private async settle(tx: Tx, inv: FullInvoice) {
    const status = inv.status === 'disputed' ? 'disputed' : settlementStatus(inv);
    const updated = status === inv.status ? inv : await tx.invoice.update({ where: { id: inv.id }, data: { status }, include });
    await emitEvent(tx, SERVICE_NAME, 'ReconciliationUpdated', inv.id, {
      invoiceId: inv.id,
      invoiceNumber: inv.number,
      orderId: inv.orderId,
      sellerOrganizationId: inv.sellerOrganizationId,
      buyerOrganizationId: inv.buyerOrganizationId,
      status: updated.status,
      paidAmount: updated.paidAmount.toString(),
      outstanding: outstanding(updated).toString(),
      currency: updated.currency,
    });
    return updated;
  }

  private async nextNumber(tx: Tx, prefix: 'INV' | 'CN') {
    const key = `${prefix}-${new Date().getUTCFullYear()}`;
    const [row] = await tx.$queryRaw<{ last: number }[]>`
      INSERT INTO ${Prisma.raw(qualified('document_counters'))} (key, last) VALUES (${key}, 1)
      ON CONFLICT (key) DO UPDATE SET last = document_counters.last + 1 RETURNING last`;
    return `${key}-${String(row!.last).padStart(6, '0')}`;
  }

  private async owned(org: ActingOrganization, invoiceId: string, side: 'seller' | 'buyer') {
    const inv = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, ...(side === 'seller' ? { sellerOrganizationId: org.organization.id } : { buyerOrganizationId: org.organization.id, status: { not: 'draft' } }) },
      include,
    });
    if (!inv) throw notFound('Invoice');
    return inv;
  }
}
