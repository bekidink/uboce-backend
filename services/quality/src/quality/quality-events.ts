import { Inject, Injectable } from '@nestjs/common';
import { EventConsumer, REDIS } from '@uboce/common';
import type { Redis } from 'ioredis';

import { SERVICE_NAME } from '../config.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma.service.js';
import { QualityService } from './quality.service.js';

/** Receipts flagged for inspection get a pending inspection automatically (PRD 6.3). */
@Injectable()
export class QualityEvents extends EventConsumer<Prisma.TransactionClient> {
  constructor(
    @Inject(REDIS) redis: Redis,
    prisma: PrismaService,
    private readonly quality: QualityService,
  ) {
    super(redis, prisma, SERVICE_NAME);
  }

  protected subscriptions() {
    return {
      GoodsReceived: this.once('GoodsReceived', async (e, tx) => {
        if (!e.data.inspectionRequired) return;
        await this.quality.openForReceipt(
          tx,
          e.data.organizationId,
          e.data.receiptId,
          e.data.lines.map((l) => ({ itemId: l.itemId, quantity: new Prisma.Decimal(l.receivedQuantity).minus(l.rejectedQuantity) })),
        );
      }),
    };
  }
}
