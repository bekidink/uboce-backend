import { Injectable } from '@nestjs/common';
import {
  type ActingOrganization,
  badRequest,
  conflict,
  emitEvent,
  notFound,
  type PaginationQueryDto,
  qualified,
  requireBusinessAccount,
  requireLocation,
  requireRole,
  skipTake,
  toPage,
} from '@uboce/common';

import { SERVICE_NAME } from '../config.js';
import { Prisma } from '../generated/prisma/client.js';
import type { CashReceipt } from '../generated/prisma/client.js';
import { outstanding } from '../invoices/money.js';
import { InvoicesService } from '../invoices/invoices.service.js';
import { PrismaService } from '../prisma.service.js';
import { decideMatch, fingerprint, invoiceNumbersIn, type MatchCandidate, parseStatementCsv, paymentCodesIn, type StatementLineInput } from './matching.js';

const { Decimal } = Prisma;
type Tx = Prisma.TransactionClient;

/** Staff who take money at a counter or in the field. */
const COLLECT_ROLES = ['owner', 'admin', 'finance_officer', 'sales_representative'];
/** Staff who reconcile the bank account. */
const RECON_ROLES = ['owner', 'admin', 'finance_officer'];
const OPEN = ['issued', 'partially_paid'] as const;
const MAX_LINES = 5000;

export type ManualMethod = 'cash' | 'mobile_money' | 'cheque' | 'bank_transfer';

/** Cash and manual payments, tills, and bank statement reconciliation (PRD v2 FIN-04, FIN-06). */
@Injectable()
export class CollectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly invoices: InvoicesService,
  ) {}

  // ---- Tills -------------------------------------------------------------------------------

  async openSession(org: ActingOrganization, userId: string, dto: { currency: string; openingFloat: string; branchId?: string }) {
    requireRole(org, COLLECT_ROLES, 'take payments');
    requireBusinessAccount(org, 'take payments');
    if (dto.branchId) requireLocation(org, dto.branchId, 'take payments at that location');
    try {
      return await this.prisma.cashSession.create({
        data: { organizationId: org.organization.id, branchId: dto.branchId ?? null, currency: dto.currency, openingFloat: dto.openingFloat, openedByUserId: userId },
      });
    } catch (error) {
      if (isUnique(error)) throw conflict('session_open', 'You already have an open till; close it first');
      throw error;
    }
  }

  async listSessions(org: ActingOrganization, userId: string, query: PaginationQueryDto & { status?: 'open' | 'closed'; mine?: boolean }) {
    requireRole(org, COLLECT_ROLES, 'view tills');
    const where: Prisma.CashSessionWhereInput = {
      organizationId: org.organization.id,
      ...(query.status ? { status: query.status } : {}),
      // Counter staff see their own tills; finance sees all.
      ...(query.mine || !RECON_ROLES.includes(org.role) ? { openedByUserId: userId } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.cashSession.findMany({ where, orderBy: { openedAt: 'desc' }, ...skipTake(query) }),
      this.prisma.cashSession.count({ where }),
    ]);
    return toPage(items, total, query);
  }

  async getSession(org: ActingOrganization, userId: string, sessionId: string) {
    requireRole(org, COLLECT_ROLES, 'view tills');
    const session = await this.prisma.cashSession.findFirst({
      where: { id: sessionId, organizationId: org.organization.id, ...(RECON_ROLES.includes(org.role) ? {} : { openedByUserId: userId }) },
      include: { receipts: { orderBy: { createdAt: 'asc' } } },
    });
    if (!session) throw notFound('Till');
    return { ...session, cashTaken: cashTotal(session.receipts).toString() };
  }

  /** Closing counts the drawer: expected is the float plus cash taken; the difference is recorded, never hidden. */
  async closeSession(org: ActingOrganization, userId: string, sessionId: string, dto: { countedAmount: string; note?: string }) {
    const session = await this.getSession(org, userId, sessionId);
    if (session.status !== 'open') throw conflict('session_closed', 'This till is already closed');
    if (session.openedByUserId !== userId && !RECON_ROLES.includes(org.role)) throw conflict('not_yours', 'Only the person who opened the till, or finance, can close it');
    const expected = session.openingFloat.plus(cashTotal(session.receipts));
    const counted = new Decimal(dto.countedAmount);
    const variance = counted.minus(expected);
    if (!variance.isZero() && !dto.note?.trim()) throw badRequest('note_required', `The count differs from the expected ${expected.toFixed(2)} by ${variance.toFixed(2)}; add a note`);
    const { count } = await this.prisma.cashSession.updateMany({
      where: { id: sessionId, status: 'open' },
      data: { status: 'closed', expectedAmount: expected, countedAmount: counted, variance, note: dto.note?.trim() || null, closedByUserId: userId, closedAt: new Date() },
    });
    if (count === 0) throw conflict('session_closed', 'This till is already closed');
    return this.getSession(org, userId, sessionId);
  }

  // ---- Manual payments ---------------------------------------------------------------------

  /**
   * Staff record money they received (cash, mobile money, cheque or a transfer
   * they can see). A receipt number is issued and the invoice settles at once.
   * Cash needs the recorder's open till. Retrying with the same Idempotency-Key
   * returns the same receipt.
   */
  async recordPayment(
    org: ActingOrganization,
    userId: string,
    invoiceId: string,
    dto: { method: ManualMethod; amount: string; externalReference?: string; sessionId?: string; note?: string },
    idempotencyKey?: string,
  ): Promise<CashReceipt> {
    requireRole(org, COLLECT_ROLES, 'record payments');
    if (idempotencyKey) {
      const prior = await this.prisma.cashReceipt.findUnique({ where: { organizationId_idempotencyKey: { organizationId: org.organization.id, idempotencyKey } } });
      if (prior) {
        if (prior.invoiceId !== invoiceId || !prior.amount.equals(dto.amount)) throw conflict('idempotency_key_reused', 'That Idempotency-Key was used for a different payment');
        return prior;
      }
    }
    const amount = new Decimal(dto.amount);
    if (!amount.gt(0)) throw badRequest('invalid_amount', 'The amount must be more than zero');

    let session = null;
    if (dto.method === 'cash' || dto.sessionId) {
      session = await this.prisma.cashSession.findFirst({
        where: { organizationId: org.organization.id, status: 'open', openedByUserId: userId, ...(dto.sessionId ? { id: dto.sessionId } : {}) },
      });
      if (!session) throw conflict('no_open_till', 'Open a till before taking cash');
      if (session.branchId) requireLocation(org, session.branchId, 'take payments at that location');
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const inv = await lockInvoice(tx, invoiceId, org.organization.id);
        if (!(OPEN as readonly string[]).includes(inv.status)) throw conflict('not_payable', `A ${inv.status} invoice is not payable`);
        if (session && session.currency !== inv.currency) throw badRequest('currency_mismatch', `The till is in ${session.currency}; the invoice is in ${inv.currency}`);
        const due = outstanding(inv);
        if (amount.gt(due)) throw badRequest('over_payment', `At most ${due.toFixed(2)} is outstanding`);

        const number = await this.invoices.nextNumber(tx, 'RCPT');
        const payment = await tx.paymentReference.create({
          data: {
            invoiceId,
            provider: dto.method,
            externalReference: number,
            amount,
            currency: inv.currency,
            status: 'confirmed',
            source: 'seller_manual',
            recordedByUserId: userId,
            occurredAt: new Date(),
          },
        });
        const receipt = await tx.cashReceipt.create({
          data: {
            number,
            organizationId: org.organization.id,
            invoiceId,
            sessionId: session?.id ?? null,
            paymentReferenceId: payment.id,
            method: dto.method,
            amount,
            currency: inv.currency,
            externalReference: dto.externalReference?.trim() || null,
            note: dto.note?.trim() || null,
            idempotencyKey: idempotencyKey ?? null,
            receivedByUserId: userId,
          },
        });
        await this.invoices.applyPayment(tx, invoiceId, payment.id, amount, `${dto.method} receipt ${number}`);
        await emitEvent(tx, SERVICE_NAME, 'ManualPaymentRecorded', invoiceId, {
          invoiceId,
          invoiceNumber: inv.number,
          sellerOrganizationId: inv.sellerOrganizationId,
          buyerOrganizationId: inv.buyerOrganizationId,
          method: dto.method,
          amount: amount.toString(),
          currency: inv.currency,
          receiptNumber: number,
          recordedByUserId: userId,
        });
        return receipt;
      });
    } catch (error) {
      // Two retries with one key racing: the loser returns the winner's receipt.
      if (idempotencyKey && isUnique(error)) return this.recordPayment(org, userId, invoiceId, dto, idempotencyKey);
      throw error;
    }
  }

  async receipt(org: ActingOrganization, number: string) {
    const receipt = await this.prisma.cashReceipt.findUnique({ where: { number } });
    if (!receipt) throw notFound('Receipt');
    const inv = await this.prisma.invoice.findUnique({ where: { id: receipt.invoiceId }, select: { number: true, sellerOrganizationId: true, buyerOrganizationId: true } });
    if (!inv || (inv.sellerOrganizationId !== org.organization.id && inv.buyerOrganizationId !== org.organization.id)) throw notFound('Receipt');
    return { ...receipt, invoiceNumber: inv.number };
  }

  /** The seller rejects a buyer's payment claim it cannot find, with a reason the buyer sees. */
  async rejectClaim(org: ActingOrganization, userId: string, invoiceId: string, paymentId: string, note: string) {
    requireRole(org, RECON_ROLES, 'review payments');
    const payment = await this.prisma.paymentReference.findFirst({ where: { id: paymentId, invoiceId, invoice: { sellerOrganizationId: org.organization.id } } });
    if (!payment) throw notFound('Payment');
    const { count } = await this.prisma.paymentReference.updateMany({
      where: { id: paymentId, status: 'pending' },
      data: { status: 'failed', reviewNote: note.trim(), recordedByUserId: userId },
    });
    if (count === 0) throw conflict('not_pending', `This payment is already ${payment.status}`);
    return this.prisma.paymentReference.findUniqueOrThrow({ where: { id: paymentId } });
  }

  // ---- Bank statements ---------------------------------------------------------------------

  async importStatement(
    org: ActingOrganization,
    userId: string,
    dto: { accountLabel: string; currency: string; fileName?: string; csv?: string; lines?: StatementLineInput[] },
  ) {
    requireRole(org, RECON_ROLES, 'reconcile the bank account');
    requireBusinessAccount(org, 'reconcile the bank account');
    let lines = dto.lines ?? [];
    let skipped = 0;
    if (dto.csv) {
      try {
        ({ lines, skipped } = parseStatementCsv(dto.csv, dto.currency));
      } catch (error) {
        throw badRequest('invalid_csv', (error as Error).message);
      }
    }
    lines = lines.filter((l) => new Decimal(l.amount).gt(0));
    if (lines.length === 0) throw badRequest('no_lines', 'No credit lines were found');
    if (lines.length > MAX_LINES) throw badRequest('too_many_lines', `Import at most ${MAX_LINES} lines at a time`);

    const statement = await this.prisma.bankStatementImport.create({
      data: { organizationId: org.organization.id, accountLabel: dto.accountLabel.trim(), fileName: dto.fileName ?? null, lineCount: lines.length, duplicateCount: 0, matchedCount: 0, importedByUserId: userId },
    });
    const created = [];
    let duplicates = 0;
    for (const l of lines) {
      try {
        created.push(
          await this.prisma.statementLine.create({
            data: {
              importId: statement.id,
              organizationId: org.organization.id,
              fingerprint: fingerprint(dto.accountLabel, l),
              bookedAt: new Date(l.bookedAt),
              amount: l.amount,
              currency: l.currency.toUpperCase(),
              reference: l.reference.slice(0, 500),
              counterparty: l.counterparty?.slice(0, 200) ?? null,
              description: l.description?.slice(0, 500) ?? null,
            },
          }),
        );
      } catch (error) {
        if (!isUnique(error)) throw error;
        duplicates++;
      }
    }

    const matched = await this.autoMatch(org.organization.id, created);
    const result = await this.prisma.bankStatementImport.update({ where: { id: statement.id }, data: { duplicateCount: duplicates, matchedCount: matched } });
    return { ...result, skippedRows: skipped, queued: created.length - matched };
  }

  /** Applies every line the rule is sure about; the rest stay in the queue with the reason. */
  private async autoMatch(organizationId: string, lines: { id: string; bookedAt: Date; amount: Prisma.Decimal; currency: string; reference: string; description: string | null }[]) {
    if (lines.length === 0) return 0;
    const text = lines.map((l) => `${l.reference} ${l.description ?? ''}`).join(' ');
    const codes = paymentCodesIn(text);
    const numbers = invoiceNumbersIn(text);
    const invoices = await this.prisma.invoice.findMany({
      where: { sellerOrganizationId: organizationId, status: { in: [...OPEN] }, OR: [{ paymentCode: { in: codes } }, { number: { in: numbers } }] },
    });
    const candidates: MatchCandidate[] = invoices.map((i) => ({ id: i.id, number: i.number, paymentCode: i.paymentCode, currency: i.currency, outstanding: outstanding(i), issuedAt: i.issuedAt }));

    let matched = 0;
    for (const line of lines) {
      const input = { bookedAt: line.bookedAt.toISOString(), amount: line.amount.toString(), currency: line.currency, reference: line.reference, description: line.description ?? undefined };
      const decision = decideMatch(input, candidates.filter((c) => c.outstanding.gt(0)));
      if (decision.kind === 'queue') {
        await this.prisma.statementLine.update({ where: { id: line.id }, data: { matchNote: decision.note, invoiceId: decision.invoiceId } });
        continue;
      }
      const ok = await this.applyLine(organizationId, line.id, decision.invoiceId, null, decision.note, true);
      if (ok) {
        matched++;
        const c = candidates.find((x) => x.id === decision.invoiceId)!;
        c.outstanding = c.outstanding.minus(line.amount);
      }
    }
    return matched;
  }

  async listLines(org: ActingOrganization, query: PaginationQueryDto & { status?: 'unmatched' | 'matched' | 'ignored' }) {
    requireRole(org, RECON_ROLES, 'reconcile the bank account');
    const where: Prisma.StatementLineWhereInput = { organizationId: org.organization.id, status: query.status ?? 'unmatched' };
    const [items, total] = await Promise.all([
      this.prisma.statementLine.findMany({ where, orderBy: { bookedAt: 'desc' }, ...skipTake(query) }),
      this.prisma.statementLine.count({ where }),
    ]);
    return toPage(items, total, query);
  }

  /** Someone in finance matches a queued line to an invoice; partial payments are fine, over-payments are not. */
  async matchLine(org: ActingOrganization, userId: string, lineId: string, invoiceId: string) {
    requireRole(org, RECON_ROLES, 'reconcile the bank account');
    const line = await this.prisma.statementLine.findFirst({ where: { id: lineId, organizationId: org.organization.id } });
    if (!line) throw notFound('Statement line');
    if (line.status !== 'unmatched') throw conflict('line_done', `This line is already ${line.status}`);
    await this.applyLine(org.organization.id, lineId, invoiceId, userId, 'matched by hand', false);
    return this.prisma.statementLine.findUniqueOrThrow({ where: { id: lineId } });
  }

  /** A deposit of a closed till's takings: the line is accounted for without touching invoices. */
  async matchDeposit(org: ActingOrganization, userId: string, lineId: string, sessionId: string) {
    requireRole(org, RECON_ROLES, 'reconcile the bank account');
    return this.prisma.$transaction(async (tx) => {
      const line = await tx.statementLine.findFirst({ where: { id: lineId, organizationId: org.organization.id, status: 'unmatched' } });
      if (!line) throw notFound('Unmatched statement line');
      const session = await tx.cashSession.findFirst({ where: { id: sessionId, organizationId: org.organization.id, status: 'closed', depositLineId: null } });
      if (!session) throw notFound('Closed, undeposited till');
      const note = line.amount.equals(session.countedAmount ?? 0) ? 'till deposit' : `till deposit; differs from the count of ${session.countedAmount?.toFixed(2)}`;
      await tx.cashSession.update({ where: { id: sessionId }, data: { depositLineId: lineId } });
      await tx.statementLine.update({ where: { id: lineId }, data: { status: 'matched', matchNote: note, matchedByUserId: userId, matchedAt: new Date() } });
      return tx.statementLine.findUniqueOrThrow({ where: { id: lineId } });
    });
  }

  async ignoreLine(org: ActingOrganization, userId: string, lineId: string, reason: string) {
    requireRole(org, RECON_ROLES, 'reconcile the bank account');
    const { count } = await this.prisma.statementLine.updateMany({
      where: { id: lineId, organizationId: org.organization.id, status: 'unmatched' },
      data: { status: 'ignored', matchNote: reason.trim(), matchedByUserId: userId, matchedAt: new Date() },
    });
    if (count === 0) throw notFound('Unmatched statement line');
    return this.prisma.statementLine.findUniqueOrThrow({ where: { id: lineId } });
  }

  /** Records the line as a confirmed bank payment on the invoice. Returns false when an automatic match no longer fits. */
  private async applyLine(organizationId: string, lineId: string, invoiceId: string, userId: string | null, note: string, exactOnly: boolean) {
    return this.prisma.$transaction(async (tx) => {
      const line = await tx.statementLine.findUniqueOrThrow({ where: { id: lineId } });
      if (line.status !== 'unmatched') return false;
      const inv = await lockInvoice(tx, invoiceId, organizationId);
      const due = outstanding(inv);
      const fits = (OPEN as readonly string[]).includes(inv.status) && inv.currency === line.currency && (exactOnly ? line.amount.equals(due) : line.amount.lte(due));
      if (!fits) {
        if (exactOnly) return false;
        if (inv.currency !== line.currency) throw badRequest('currency_mismatch', `The line is in ${line.currency}; the invoice is in ${inv.currency}`);
        if (!(OPEN as readonly string[]).includes(inv.status)) throw conflict('not_payable', `A ${inv.status} invoice is not payable`);
        throw badRequest('over_payment', `Only ${due.toFixed(2)} is outstanding; refund or credit the difference separately`);
      }
      const payment = await tx.paymentReference.create({
        data: {
          invoiceId,
          provider: 'bank_transfer',
          externalReference: `stmt:${line.id}`,
          amount: line.amount,
          currency: line.currency,
          status: 'confirmed',
          source: 'bank_statement',
          recordedByUserId: userId,
          occurredAt: line.bookedAt,
        },
      });
      await tx.statementLine.update({
        where: { id: lineId },
        data: { status: 'matched', invoiceId, paymentReferenceId: payment.id, matchNote: note, matchedByUserId: userId, matchedAt: new Date() },
      });
      await this.invoices.applyPayment(tx, invoiceId, payment.id, line.amount, `bank statement: ${line.reference}`.slice(0, 200));
      return true;
    });
  }
}

/** Row lock so two payments can't both pass the outstanding check. */
async function lockInvoice(tx: Tx, invoiceId: string, sellerOrganizationId: string) {
  await tx.$queryRaw`SELECT id FROM ${Prisma.raw(qualified('invoices'))} WHERE id = ${invoiceId}::uuid FOR UPDATE`;
  const inv = await tx.invoice.findFirst({ where: { id: invoiceId, sellerOrganizationId } });
  if (!inv) throw notFound('Invoice');
  return inv;
}

const cashTotal = (receipts: { method: string; amount: Prisma.Decimal }[]) =>
  receipts.filter((r) => r.method === 'cash').reduce((s, r) => s.plus(r.amount), new Decimal(0));

const isUnique = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
