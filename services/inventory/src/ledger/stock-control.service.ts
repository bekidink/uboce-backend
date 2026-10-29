import { HttpStatus, Injectable } from '@nestjs/common';
import { type ActingOrganization, AppError, badRequest, conflict, forbidden, notFound, type PaginationQueryDto, qualified, requirePermission, requireRole, skipTake, toPage } from '@uboce/common';

import { Prisma } from '../generated/prisma/client.js';
import type { StockState } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma.service.js';
import { LedgerService } from './ledger.service.js';
import { changeState } from './rules.js';

type Tx = Prisma.TransactionClient;
const { Decimal } = Prisma;

export const STOCK_ROLES = ['owner', 'admin', 'warehouse_operator'];
const APPROVER_ROLES = ['owner', 'admin'];

/**
 * Stock states (available / damaged / quarantined) and cycle counts (PRD addendum 2.1).
 * States split on-hand stock without moving it; write-offs and count variances are ledger adjustments.
 */
@Injectable()
export class StockControlService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
  ) {}

  // ---- States ------------------------------------------------------------------------------

  async changeState(
    org: ActingOrganization,
    userId: string,
    dto: { warehouseId: string; itemId: string; from: StockState; to: StockState; quantity: string; reason: string },
  ) {
    requireRole(org, [...STOCK_ROLES, 'quality_inspector'], 'change stock states');
    return this.prisma.$transaction((tx) => this.changeStateTx(tx, org.organization.id, `user:${userId}`, dto, 'manual', null));
  }

  async changeStateTx(
    tx: Tx,
    organizationId: string,
    createdBy: string,
    dto: { warehouseId: string; itemId: string; from: StockState; to: StockState; quantity: string; reason: string },
    sourceType: string,
    sourceId: string | null,
  ) {
    const balance = await this.ledger.lockBalance(tx, organizationId, dto.warehouseId, dto.itemId);
    const result = changeState(balance, dto.from, dto.to, new Decimal(dto.quantity));
    if ('error' in result) throw new AppError(HttpStatus.CONFLICT, 'invalid_state_change', result.error);
    await tx.stockBalance.update({
      where: { organizationId_warehouseId_itemId: { organizationId, warehouseId: dto.warehouseId, itemId: dto.itemId } },
      data: result.next,
    });
    return tx.stockStateChange.create({
      data: { organizationId, warehouseId: dto.warehouseId, itemId: dto.itemId, fromState: dto.from, toState: dto.to, quantity: dto.quantity, reason: dto.reason, sourceType, sourceId, createdBy },
    });
  }

  /** Writes damaged stock off the books: leaves the damaged state and on-hand together. */
  async writeOff(org: ActingOrganization, userId: string, dto: { warehouseId: string; itemId: string; quantity: string; reason: string }) {
    requireRole(org, APPROVER_ROLES, 'write off stock');
    requirePermission(org, 'stock:write_off', 'write off stock');
    const quantity = new Decimal(dto.quantity);
    return this.prisma.$transaction(async (tx) => {
      const balance = await this.ledger.lockBalance(tx, org.organization.id, dto.warehouseId, dto.itemId);
      if (quantity.greaterThan(balance.damaged)) throw conflict('not_damaged', `Only ${balance.damaged.toString()} is marked damaged`);
      await tx.stockBalance.update({
        where: { organizationId_warehouseId_itemId: { organizationId: org.organization.id, warehouseId: dto.warehouseId, itemId: dto.itemId } },
        data: { damaged: { decrement: quantity } },
      });
      const change = await tx.stockStateChange.create({
        data: {
          organizationId: org.organization.id,
          warehouseId: dto.warehouseId,
          itemId: dto.itemId,
          fromState: 'damaged',
          toState: 'available',
          quantity,
          reason: `write-off: ${dto.reason}`,
          sourceType: 'write_off',
          createdBy: `user:${userId}`,
        },
      });
      // The adjustment draws the freed quantity straight back out of on-hand.
      await this.ledger.postTx(tx, {
        idempotencyKey: `write-off:${change.id}`,
        organizationId: org.organization.id,
        warehouseId: dto.warehouseId,
        itemId: dto.itemId,
        type: 'adjustment',
        quantity: quantity.negated().toString(),
        sourceType: 'adjustment',
        sourceId: 'damage_write_off',
        note: dto.reason,
        createdBy: `user:${userId}`,
      });
      return change;
    });
  }

  async stateChanges(org: ActingOrganization, filter: { itemId?: string; warehouseId?: string }, query: PaginationQueryDto) {
    const where = { organizationId: org.organization.id, ...filter };
    const [items, total] = await Promise.all([
      this.prisma.stockStateChange.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(query) }),
      this.prisma.stockStateChange.count({ where }),
    ]);
    return toPage(items, total, query);
  }

  // ---- Cycle counts -----------------------------------------------------------------------------

  /** Starts a count: snapshots what the ledger expects for each item (all items in the warehouse, or the given ones). */
  async startCount(org: ActingOrganization, userId: string, dto: { warehouseId: string; itemIds?: string[]; note?: string }) {
    requireRole(org, STOCK_ROLES, 'count stock');
    const balances = await this.prisma.stockBalance.findMany({
      where: { organizationId: org.organization.id, warehouseId: dto.warehouseId, ...(dto.itemIds?.length ? { itemId: { in: dto.itemIds } } : {}) },
    });
    const known = new Map(balances.map((b) => [b.itemId, b.onHand]));
    const itemIds = dto.itemIds?.length ? dto.itemIds : balances.map((b) => b.itemId);
    if (!itemIds.length) throw badRequest('nothing_to_count', 'This warehouse has no stock yet; name the items to count');
    const open = await this.prisma.cycleCount.count({ where: { organizationId: org.organization.id, warehouseId: dto.warehouseId, status: { in: ['counting', 'submitted'] } } });
    if (open) throw conflict('count_in_progress', 'Finish the open count for this warehouse first');
    return this.prisma.$transaction(async (tx) =>
      tx.cycleCount.create({
        data: {
          number: await this.nextNumber(tx),
          organizationId: org.organization.id,
          warehouseId: dto.warehouseId,
          note: dto.note,
          createdByUserId: userId,
          lines: { create: itemIds.map((itemId) => ({ itemId, expectedQuantity: known.get(itemId) ?? new Decimal(0) })) },
        },
        include: { lines: true },
      }),
    );
  }

  async listCounts(org: ActingOrganization, query: PaginationQueryDto) {
    const where = { organizationId: org.organization.id };
    const [items, total] = await Promise.all([
      this.prisma.cycleCount.findMany({ where, include: { lines: true }, orderBy: { createdAt: 'desc' }, ...skipTake(query) }),
      this.prisma.cycleCount.count({ where }),
    ]);
    return toPage(items, total, query);
  }

  async getCount(org: ActingOrganization, id: string) {
    const count = await this.prisma.cycleCount.findFirst({ where: { id, organizationId: org.organization.id }, include: { lines: true } });
    if (!count) throw notFound('Cycle count');
    return count;
  }

  /** Records counted quantities (can be called repeatedly while counting). */
  async record(org: ActingOrganization, id: string, lines: { itemId: string; countedQuantity: string; note?: string }[]) {
    requireRole(org, STOCK_ROLES, 'count stock');
    const count = await this.getCount(org, id);
    if (count.status !== 'counting') throw conflict('invalid_state', `A ${count.status} count cannot be edited`);
    const byItem = new Map(count.lines.map((l) => [l.itemId, l]));
    return this.prisma.$transaction(async (tx) => {
      for (const l of lines) {
        const line = byItem.get(l.itemId);
        if (line) await tx.cycleCountLine.update({ where: { id: line.id }, data: { countedQuantity: l.countedQuantity, note: l.note } });
        else await tx.cycleCountLine.create({ data: { cycleCountId: id, itemId: l.itemId, expectedQuantity: 0, countedQuantity: l.countedQuantity, note: l.note } });
      }
      return tx.cycleCount.findUniqueOrThrow({ where: { id }, include: { lines: true } });
    });
  }

  async submit(org: ActingOrganization, userId: string, id: string) {
    requireRole(org, STOCK_ROLES, 'count stock');
    const count = await this.getCount(org, id);
    if (count.status !== 'counting') throw conflict('invalid_state', `A ${count.status} count cannot be submitted`);
    if (count.lines.some((l) => l.countedQuantity === null)) throw badRequest('incomplete_count', 'Count every line before submitting');
    return this.prisma.cycleCount.update({ where: { id }, data: { status: 'submitted', submittedByUserId: userId, submittedAt: new Date() }, include: { lines: true } });
  }

  /**
   * Approval posts each variance as an adjustment (reason code cycle_count). Separation of
   * duties: whoever submitted the count cannot approve it.
   */
  async approve(org: ActingOrganization, userId: string, id: string) {
    requireRole(org, APPROVER_ROLES, 'approve counts');
    const count = await this.getCount(org, id);
    if (count.status !== 'submitted') throw conflict('invalid_state', `A ${count.status} count cannot be approved`);
    if (count.submittedByUserId === userId) throw forbidden('The person who submitted a count cannot approve it');
    for (const line of count.lines) {
      // Variance against the ledger now (movements during the count are counted by the snapshot difference).
      const variance = new Decimal(line.countedQuantity!).minus(line.expectedQuantity);
      if (variance.isZero()) continue;
      await this.ledger.post({
        idempotencyKey: `count:${count.id}:${line.itemId}`,
        organizationId: count.organizationId,
        warehouseId: count.warehouseId,
        itemId: line.itemId,
        type: 'adjustment',
        quantity: variance.toString(),
        sourceType: 'adjustment',
        sourceId: 'cycle_count',
        note: `Cycle count ${count.number}`,
        createdBy: `user:${userId}`,
      });
    }
    return this.prisma.cycleCount.update({ where: { id }, data: { status: 'approved', approvedByUserId: userId, approvedAt: new Date() }, include: { lines: true } });
  }

  async cancel(org: ActingOrganization, id: string) {
    requireRole(org, STOCK_ROLES, 'count stock');
    const count = await this.getCount(org, id);
    if (!['counting', 'submitted'].includes(count.status)) throw conflict('invalid_state', `A ${count.status} count cannot be cancelled`);
    return this.prisma.cycleCount.update({ where: { id }, data: { status: 'cancelled' }, include: { lines: true } });
  }

  private async nextNumber(tx: Tx) {
    const year = new Date().getUTCFullYear();
    const [row] = await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint + 1 AS n FROM ${Prisma.raw(qualified('cycle_counts'))} WHERE number LIKE ${`CC-${year}-%`}`;
    return `CC-${year}-${String(row!.n).padStart(5, '0')}`;
  }
}
