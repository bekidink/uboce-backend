import { Inject, Injectable } from '@nestjs/common';
import { EventConsumer, REDIS } from '@uboce/common';
import type { Redis } from 'ioredis';

import { SERVICE_NAME } from '../config.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma.service.js';
import { InvoicesService } from './invoices.service.js';

/** Disputes on an invoice freeze its settlement status until resolved (PRD 5.15: disputed outcome). */
@Injectable()
export class FinanceEvents extends EventConsumer<Prisma.TransactionClient> {
  constructor(
    @Inject(REDIS) redis: Redis,
    prisma: PrismaService,
    private readonly invoices: InvoicesService,
  ) {
    super(redis, prisma, SERVICE_NAME);
  }

  protected subscriptions() {
    return {
      DisputeOpened: this.once('DisputeOpened', async (e, tx) => {
        if (e.data.subjectType === 'invoice') await this.invoices.markDisputed(tx, e.data.subjectId);
      }),
      DisputeResolved: this.once('DisputeResolved', async (e, tx) => {
        if (e.data.subjectType === 'invoice') await this.invoices.clearDispute(tx, e.data.subjectId);
      }),
    };
  }
}
