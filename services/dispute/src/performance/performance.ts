import { Inject, Injectable } from '@nestjs/common';
import { EventConsumer, REDIS } from '@uboce/common';
import type { Redis } from 'ioredis';

import { SERVICE_NAME } from '../config.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma.service.js';
import { computeMetrics } from './metrics.js';

type Tx = Prisma.TransactionClient;

@Injectable()
export class PerformanceService {
  constructor(private readonly prisma: PrismaService) {}

  async supplier(organizationId: string, days: number) {
    const since = new Date(Date.now() - days * 86_400_000);
    const facts = await this.prisma.supplierFact.findMany({
      where: { supplierOrganizationId: organizationId, occurredAt: { gte: since } },
      select: { kind: true, reference: true, occurredAt: true },
    });
    return { supplierOrganizationId: organizationId, windowDays: days, ...computeMetrics(facts) };
  }
}

/** Records supplier facts from commerce, logistics and dispute events. */
@Injectable()
export class PerformanceEvents extends EventConsumer<Tx> {
  constructor(@Inject(REDIS) redis: Redis, prisma: PrismaService) {
    super(redis, prisma, `${SERVICE_NAME}-performance`);
  }

  private fact(tx: Tx, supplierOrganizationId: string, kind: string, reference: string, occurredAt: string, sourceEventId: string) {
    return tx.supplierFact.create({ data: { supplierOrganizationId, kind, reference, occurredAt: new Date(occurredAt), sourceEventId } });
  }

  protected subscriptions() {
    return {
      PurchaseOrderCreated: this.once('PurchaseOrderCreated', (e, tx) =>
        this.fact(tx, e.data.supplierOrganizationId, 'order_created', e.data.orderId, e.occurredAt, e.eventId).then(() => undefined),
      ),
      PurchaseOrderConfirmed: this.once('PurchaseOrderConfirmed', (e, tx) =>
        this.fact(tx, e.data.supplierOrganizationId, 'order_confirmed', e.data.orderId, e.occurredAt, e.eventId).then(() => undefined),
      ),
      // Only the supplier's own cancellations count against it.
      PurchaseOrderCancelled: this.once('PurchaseOrderCancelled', async (e, tx) => {
        if (e.data.party === 'supplier') await this.fact(tx, e.data.supplierOrganizationId, 'order_cancelled', e.data.orderId, e.occurredAt, e.eventId);
      }),
      DeliveryConfirmed: this.once('DeliveryConfirmed', (e, tx) =>
        this.fact(tx, e.data.shipperOrganizationId, e.data.complete ? 'delivery_complete' : 'delivery_partial', e.data.shipmentId, e.occurredAt, e.eventId).then(() => undefined),
      ),
      DisputeOpened: this.once('DisputeOpened', (e, tx) =>
        this.fact(tx, e.data.againstOrganizationId, 'dispute_opened', e.data.disputeId, e.occurredAt, e.eventId).then(() => undefined),
      ),
      // A finding, not an allegation (PRD 5.18).
      DisputeResolved: this.once('DisputeResolved', async (e, tx) => {
        if (e.data.outcome === 'in_favor_of_opener') await this.fact(tx, e.data.againstOrganizationId, 'dispute_lost', e.data.disputeId, e.occurredAt, e.eventId);
      }),
    };
  }
}
