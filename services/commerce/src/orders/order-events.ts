import { Inject, Injectable, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { handleOnce, REDIS, StreamConsumer } from '@uboce/common';
import type { DomainEvent } from '@uboce/contracts';
import type { Redis } from 'ioredis';

import { SERVICE_NAME } from '../config.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma.service.js';
import { OrdersService } from './orders.service.js';

/** Accepted quotations become purchase orders (PRD 6.2). */
@Injectable()
export class OrderEventHandlers implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly consumer: StreamConsumer;

  constructor(
    @Inject(REDIS) redis: Redis,
    prisma: PrismaService,
    orders: OrdersService,
  ) {
    this.consumer = new StreamConsumer(redis, {
      group: SERVICE_NAME,
      handlers: {
        QuotationAccepted: (event) =>
          handleOnce<Prisma.TransactionClient>(prisma, event, (tx) =>
            orders.createFromQuotation(tx, event as DomainEvent<'QuotationAccepted'>),
          ).then(() => undefined),
      },
    });
  }

  async onApplicationBootstrap() {
    await this.consumer.start();
  }

  async beforeApplicationShutdown() {
    await this.consumer.stop();
  }
}
