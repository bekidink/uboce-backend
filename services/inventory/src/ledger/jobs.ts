import { Injectable, Logger } from '@nestjs/common';
import { CommerceClient, emitEvent, JobRegistry } from '@uboce/common';

import { env, SERVICE_NAME } from '../config.js';
import { PrismaService } from '../prisma.service.js';
import { LedgerService } from './ledger.service.js';

const DAY = 86_400_000;
const FINISHED = new Set(['cancelled', 'closed', 'fulfilled']);

/** Inventory timers the scheduler triggers (PRD v2 INV-02, INV-04, PLT-03). */
@Injectable()
export class InventoryJobs {
  private readonly logger = new Logger(InventoryJobs.name);

  constructor(
    jobs: JobRegistry,
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly commerce: CommerceClient,
  ) {
    jobs.register('reservations.release-stale', () => this.releaseStale());
    jobs.register('stock.expiry-alerts', () => this.expiryAlerts());
  }

  /**
   * Safety net for missed events: order reservations still held after
   * RESERVATION_CHECK_DAYS are released when the order is finished or gone.
   * Fulfilled orders are released too, since anything still held was never issued.
   */
  async releaseStale(now = new Date()) {
    const stale = await this.prisma.stockReservation.findMany({
      where: { status: 'active', referenceType: 'order', updatedAt: { lt: new Date(now.getTime() - env.RESERVATION_CHECK_DAYS * DAY) } },
      select: { referenceId: true },
      orderBy: { updatedAt: 'asc' },
      take: 200,
    });
    let n = 0;
    for (const { referenceId } of stale) {
      const order = await this.commerce.getOrder(referenceId);
      if (order && !FINISHED.has(order.status)) {
        // Still in progress: look again next window.
        await this.prisma.stockReservation.update({ where: { referenceType_referenceId: { referenceType: 'order', referenceId } }, data: { updatedAt: now } });
        continue;
      }
      const { released } = await this.ledger.release('order', referenceId);
      if (released) {
        n++;
        this.logger.warn(`Released stale reservation for order ${referenceId} (${order?.status ?? 'missing'})`);
      }
    }
    return n;
  }

  /** One alert per organization holding batches that expire within STOCK_EXPIRY_ALERT_DAYS (expired ones included). */
  async expiryAlerts(now = new Date()) {
    const horizon = new Date(now.getTime() + env.STOCK_EXPIRY_ALERT_DAYS * DAY);
    const groups = await this.prisma.stockBatch.groupBy({
      by: ['organizationId'],
      where: { onHand: { gt: 0 }, expiresOn: { not: null, lte: horizon } },
      _count: { _all: true },
      _min: { expiresOn: true },
    });
    for (const g of groups) {
      await this.prisma.$transaction((tx) =>
        emitEvent(tx, SERVICE_NAME, 'StockExpiring', g.organizationId, {
          organizationId: g.organizationId,
          batches: g._count._all,
          earliestExpiresOn: g._min.expiresOn!.toISOString().slice(0, 10),
          withinDays: env.STOCK_EXPIRY_ALERT_DAYS,
        }),
      );
    }
    return groups.length;
  }
}
