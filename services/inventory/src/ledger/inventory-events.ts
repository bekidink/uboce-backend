import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventConsumer, REDIS } from '@uboce/common';
import type { Redis } from 'ioredis';

import { SERVICE_NAME } from '../config.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma.service.js';
import { LedgerService } from './ledger.service.js';

type Tx = Prisma.TransactionClient;

/**
 * Order lifecycle → reservations (PRD 6.2). (Produce lots and production post their stock synchronously.)
 * The reservation itself runs in its own transaction after the inbox row, so a
 * failure is retried by redelivery.
 */
@Injectable()
export class InventoryEvents extends EventConsumer<Tx> {
  private readonly logger = new Logger(InventoryEvents.name);

  constructor(
    @Inject(REDIS) redis: Redis,
    prisma: PrismaService,
    private readonly ledger: LedgerService,
  ) {
    super(redis, prisma, SERVICE_NAME);
  }

  protected subscriptions() {
    return {
      // Only suppliers that keep stock here get reservations; others manage stock elsewhere.
      PurchaseOrderConfirmed: this.on('PurchaseOrderConfirmed', async (e) => {
        const lines = e.data.lines.filter((l) => l.productId).map((l) => ({ itemId: l.productId!, quantity: l.quantity }));
        if (lines.length === 0 || !(await this.ledger.tracksStock(e.data.supplierOrganizationId))) return;
        const result = await this.ledger.reserve({
          organizationId: e.data.supplierOrganizationId,
          referenceType: 'order',
          referenceId: e.data.orderId,
          lines,
        });
        this.logger.log(`Reservation for order ${e.data.orderId}: ${result.status}`);
      }),
      PurchaseOrderCancelled: this.on('PurchaseOrderCancelled', async (e) => {
        await this.ledger.release('order', e.data.orderId);
      }),
      // Pickup orders have no shipment: the handover issues the reserved stock.
      PurchaseOrderFulfillmentUpdated: this.on('PurchaseOrderFulfillmentUpdated', async (e) => {
        if (!e.data.handover) return;
        const result = await this.ledger.consumeForHandover(e.data.orderId);
        this.logger.log(`Pickup handover for order ${e.data.orderId}: ${result.issued} line(s) issued`);
      }),
    };
  }
}
