import { Injectable } from '@nestjs/common';
import { emitEvent, JobRegistry } from '@uboce/common';

import { env, SERVICE_NAME } from '../config.js';
import { outstanding } from '../invoices/money.js';
import { PrismaService } from '../prisma.service.js';

const DAY = 86_400_000;

/** Finance timers the scheduler triggers (PRD v2 PLT-03, FIN-05). */
@Injectable()
export class FinanceJobs {
  constructor(
    jobs: JobRegistry,
    private readonly prisma: PrismaService,
  ) {
    jobs.register('invoices.mark-overdue', () => this.markOverdue());
    jobs.register('payments.expire-attempts', () => this.expireAttempts());
  }

  /**
   * Unpaid invoices past their due date are marked overdue and the buyer is
   * told; reminders follow every INVOICE_REMINDER_DAYS, up to INVOICE_MAX_REMINDERS.
   */
  async markOverdue(now = new Date()) {
    const remindBefore = new Date(now.getTime() - env.INVOICE_REMINDER_DAYS * DAY);
    const due = await this.prisma.invoice.findMany({
      where: {
        status: { in: ['issued', 'partially_paid'] },
        dueDate: { lt: now },
        remindersSent: { lt: env.INVOICE_MAX_REMINDERS },
        OR: [{ lastReminderAt: null }, { lastReminderAt: { lt: remindBefore } }],
      },
      orderBy: { dueDate: 'asc' },
      take: 500,
    });
    let n = 0;
    for (const inv of due) {
      const left = outstanding(inv);
      if (!left.gt(0)) continue;
      await this.prisma.$transaction(async (tx) => {
        // Conditional on the reminder count we read, so overlapping runs send one reminder.
        const { count } = await tx.invoice.updateMany({
          where: { id: inv.id, remindersSent: inv.remindersSent },
          data: { overdueAt: inv.overdueAt ?? now, remindersSent: { increment: 1 }, lastReminderAt: now },
        });
        if (count === 0) return;
        await emitEvent(tx, SERVICE_NAME, 'InvoiceOverdue', inv.id, {
          invoiceId: inv.id,
          invoiceNumber: inv.number,
          sellerOrganizationId: inv.sellerOrganizationId,
          buyerOrganizationId: inv.buyerOrganizationId,
          outstanding: left.toString(),
          currency: inv.currency,
          dueDate: inv.dueDate.toISOString(),
          daysOverdue: Math.max(0, Math.floor((now.getTime() - inv.dueDate.getTime()) / DAY)),
          reminder: inv.remindersSent + 1,
        });
        n++;
      });
    }
    return n;
  }

  /**
   * Checkout attempts nobody finished are closed so the buyer can start again
   * (FIN-05). They are marked failed/expired, not cancelled: a late provider
   * success still marks the attempt succeeded, and the invoice is credited either way.
   */
  async expireAttempts(now = new Date()) {
    const cutoff = new Date(now.getTime() - env.PAYMENT_ATTEMPT_TTL_MINUTES * 60_000);
    const stale = await this.prisma.paymentIntent.findMany({
      where: { status: 'pending', createdAt: { lt: cutoff } },
      include: { invoice: { select: { number: true, buyerOrganizationId: true, sellerOrganizationId: true, status: true } } },
      take: 500,
    });
    let n = 0;
    for (const intent of stale) {
      await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.paymentIntent.updateMany({ where: { id: intent.id, status: 'pending' }, data: { status: 'failed', failureReason: 'expired' } });
        if (count === 0) return;
        n++;
        // Only worth telling the buyer while there is still something to pay.
        if (!['issued', 'partially_paid'].includes(intent.invoice.status)) return;
        await emitEvent(tx, SERVICE_NAME, 'PaymentAttemptUpdated', intent.id, {
          intentId: intent.id,
          invoiceId: intent.invoiceId,
          invoiceNumber: intent.invoice.number,
          buyerOrganizationId: intent.invoice.buyerOrganizationId,
          sellerOrganizationId: intent.invoice.sellerOrganizationId,
          provider: intent.provider,
          status: 'expired',
          reason: 'not completed in time',
        });
      });
    }
    return n;
  }
}
