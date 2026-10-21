import { Inject, Injectable } from '@nestjs/common';
import { EventConsumer, REDIS } from '@uboce/common';
import type { Redis } from 'ioredis';

import { SERVICE_NAME } from '../config.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma.service.js';
import { WarehouseService } from './warehouse.service.js';

/** Quality's decision releases inspected receipts into stock (PRD 6.3). */
@Injectable()
export class WarehouseEvents extends EventConsumer<Prisma.TransactionClient> {
  constructor(
    @Inject(REDIS) redis: Redis,
    prisma: PrismaService,
    private readonly warehouse: WarehouseService,
  ) {
    super(redis, prisma, SERVICE_NAME);
  }

  protected subscriptions() {
    return {
      // Idempotent on its own: a receipt is only posted while pending, with fixed movement keys.
      InspectionCompleted: this.on('InspectionCompleted', async (e) => {
        if (e.data.subjectType !== 'receipt') return;
        const accepted = new Map<string, Prisma.Decimal>();
        for (const l of e.data.lines) {
          accepted.set(l.itemId, (accepted.get(l.itemId) ?? new Prisma.Decimal(0)).plus(l.acceptedQuantity));
        }
        await this.warehouse.applyInspection(e.data.subjectId, e.data.inspectionId, accepted);
      }),
    };
  }
}
