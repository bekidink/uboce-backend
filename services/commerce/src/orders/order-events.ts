import { Inject, Injectable } from '@nestjs/common';
import { EventConsumer, REDIS } from '@uboce/common';
import type { Redis } from 'ioredis';

import { SERVICE_NAME } from '../config.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma.service.js';
import { OrdersService } from './orders.service.js';

/**
 * Accepted quotations become orders (PRD 6.2); stock and delivery outcomes
 * move them through fulfillment (PRD 6.3). Each event is applied once.
 */
@Injectable()
export class OrderEventHandlers extends EventConsumer<Prisma.TransactionClient> {
  constructor(
    @Inject(REDIS) redis: Redis,
    prisma: PrismaService,
    private readonly orders: OrdersService,
  ) {
    super(redis, prisma, SERVICE_NAME);
  }

  protected subscriptions() {
    return {
      QuotationAccepted: this.once('QuotationAccepted', (e, tx) => this.orders.createFromQuotation(tx, e)),
      StockReservationFailed: this.once('StockReservationFailed', (e, tx) =>
        this.orders.markException(tx, e.data.orderId, `Stock reservation failed: ${e.data.shortages.map((s) => `${s.itemId} needs ${s.requested}, ${s.available} available`).join('; ')}`),
      ),
      DeliveryConfirmed: this.once('DeliveryConfirmed', (e, tx) => this.orders.applyDelivery(tx, e.data.orderId, e.data.items)),
      ShipmentStatusChanged: this.once('ShipmentStatusChanged', async (e, tx) => {
        if (e.data.status !== 'failed') return;
        for (const orderId of e.data.orderIds) await this.orders.markDeliveryFailed(tx, orderId, e.data.reason ?? 'the carrier could not deliver');
      }),
    };
  }
}
