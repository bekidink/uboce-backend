import { Injectable } from '@nestjs/common';
import { JobRegistry } from '@uboce/common';

import { env } from './config.js';
import { PrismaService } from './prisma.service.js';

/** Quote validity and RFQ closing, triggered by the scheduler (PRD v2 ORD-03, PLT-03). */
@Injectable()
export class ProcurementJobs {
  constructor(
    jobs: JobRegistry,
    private readonly prisma: PrismaService,
  ) {
    jobs.register('quotations.expire', () => this.expireQuotations());
    jobs.register('rfqs.close-stale', () => this.closeStaleRfqs());
  }

  /** Quotations past their validity can no longer be accepted; a revision makes one live again. */
  async expireQuotations(now = new Date()) {
    const { count } = await this.prisma.quotation.updateMany({ where: { status: 'submitted', validUntil: { lte: now } }, data: { status: 'expired' } });
    return count;
  }

  /** Published RFQs nobody awarded within RFQ_AWARD_WINDOW_DAYS after the deadline are closed. */
  async closeStaleRfqs(now = new Date()) {
    const cutoff = new Date(now.getTime() - env.RFQ_AWARD_WINDOW_DAYS * 86_400_000);
    const { count } = await this.prisma.rfq.updateMany({
      where: { status: 'published', awardedQuotationId: null, responseDeadline: { lt: cutoff } },
      data: { status: 'closed' },
    });
    return count;
  }
}
