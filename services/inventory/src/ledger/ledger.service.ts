import { createHash } from 'node:crypto';

import { HttpStatus, Injectable } from '@nestjs/common';
import { AppError, conflict, emitEvent, notFound, type PaginationQueryDto, skipTake, toPage, qualified } from '@uboce/common';
import type { PostMovementRequest, ReserveStockRequest, ReserveStockResult } from '@uboce/contracts';

import { SERVICE_NAME } from '../config.js';
import { Prisma } from '../generated/prisma/client.js';
import type { MovementType } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma.service.js';
import { allocate, applyMovement, type BalanceState, DECREASING } from './rules.js';

type Tx = Prisma.TransactionClient;
const { Decimal } = Prisma;

export type MovementInput = Omit<PostMovementRequest, 'type'> & { type: MovementType; createdBy: string };

const hashOf = (input: MovementInput) => {
  const { createdBy: _ignored, ...rest } = input;
  void _ignored;
  return createHash('sha256').update(JSON.stringify(rest, Object.keys(rest).sort())).digest('hex');
};

@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Posts one movement exactly once (idempotency key), locking the balance row
   * so concurrent postings serialize and stock can't be oversold (PRD 5.9).
   */
  async post(input: MovementInput): Promise<{ movementId: string; replayed: boolean }> {
    const requestHash = hashOf(input);
    const existing = await this.prisma.stockMovement.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) return this.replay(existing.id, existing.requestHash, requestHash);

    try {
      return await this.prisma.$transaction((tx) => this.postTx(tx, input, requestHash));
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const winner = await this.prisma.stockMovement.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
        if (winner) return this.replay(winner.id, winner.requestHash, requestHash);
      }
      throw error;
    }
  }

  /**
   * Posts several movements all-or-nothing (e.g. every line of a transfer leaving a warehouse):
   * if one line is short, none is posted. Each keeps its own idempotency key, so a retried batch
   * replays the lines that already went through.
   */
  async postBatch(inputs: MovementInput[]): Promise<{ movements: { movementId: string; replayed: boolean }[] }> {
    if (new Set(inputs.map((i) => i.idempotencyKey)).size !== inputs.length) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'duplicate_key', 'Each movement in a batch needs its own idempotency key');
    }
    // Balances are locked in one fixed order, so two batches over the same items can't deadlock.
    const ordered = inputs.map((input, index) => ({ input, index })).sort((a, b) => `${a.input.warehouseId}:${a.input.itemId}`.localeCompare(`${b.input.warehouseId}:${b.input.itemId}`));
    try {
      return await this.prisma.$transaction(async (tx) => {
        const movements: { movementId: string; replayed: boolean }[] = [];
        for (const { input, index } of ordered) {
          const requestHash = hashOf(input);
          const existing = await tx.stockMovement.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
          movements[index] = existing ? this.replay(existing.id, existing.requestHash, requestHash) : await this.postTx(tx, input, requestHash);
        }
        return { movements };
      });
    } catch (error) {
      // Another request posted one of these keys at the same moment: the caller retries and gets replays.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw conflict('concurrent_change', 'Some of these movements were just posted; retry');
      throw error;
    }
  }

  async postTx(tx: Tx, input: MovementInput, requestHash = hashOf(input)) {
    const quantity = new Decimal(input.quantity);
    let fromReserved = new Decimal(0);
    let reservationLine: { id: string; remaining: Prisma.Decimal; reservationId: string } | null = null;

    if (input.reservation && DECREASING.has(input.type)) {
      const reservation = await tx.stockReservation.findUnique({
        where: { referenceType_referenceId: { referenceType: input.reservation.referenceType, referenceId: input.reservation.referenceId } },
        include: { lines: true },
      });
      const line = reservation?.status === 'active' ? reservation.lines.find((l) => l.itemId === input.itemId && l.warehouseId === input.warehouseId) : undefined;
      if (line) {
        const remaining = line.quantity.minus(line.consumedQuantity);
        fromReserved = Decimal.min(remaining, quantity.abs());
        reservationLine = { id: line.id, remaining, reservationId: line.reservationId };
      }
    }

    const balance = await this.lockBalance(tx, input.organizationId, input.warehouseId, input.itemId);
    const result = applyMovement(balance, input.type, quantity, fromReserved);
    if ('error' in result) throw new AppError(HttpStatus.CONFLICT, 'insufficient_stock', result.error, { itemId: input.itemId, ...stringify(balance) });

    await this.saveBalance(tx, input.organizationId, input.warehouseId, input.itemId, result.next);
    const movement = await tx.stockMovement.create({
      data: {
        organizationId: input.organizationId,
        warehouseId: input.warehouseId,
        itemId: input.itemId,
        type: input.type,
        quantity,
        unitOfMeasure: input.unitOfMeasure,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        reservationId: reservationLine?.reservationId,
        batchCode: input.batchCode,
        expiresOn: input.expiresOn ? new Date(input.expiresOn) : undefined,
        note: input.note,
        createdBy: input.createdBy,
      },
    });
    await this.applyBatches(tx, input, quantity);

    if (reservationLine && fromReserved.greaterThan(0)) {
      await tx.stockReservationLine.update({ where: { id: reservationLine.id }, data: { consumedQuantity: { increment: fromReserved } } });
      const lines = await tx.stockReservationLine.findMany({ where: { reservationId: reservationLine.reservationId } });
      if (lines.every((l) => l.consumedQuantity.greaterThanOrEqualTo(l.quantity))) {
        await tx.stockReservation.update({ where: { id: reservationLine.reservationId }, data: { status: 'consumed' } });
      }
    }

    await emitEvent(tx, SERVICE_NAME, 'StockMovementPosted', movement.id, {
      movementId: movement.id,
      organizationId: movement.organizationId,
      warehouseId: movement.warehouseId,
      itemId: movement.itemId,
      type: movement.type,
      quantity: movement.quantity.toString(),
      sourceType: movement.sourceType,
      sourceId: movement.sourceId,
    });
    return { movementId: movement.id, replayed: false };
  }

  /**
   * Keeps per-batch stock in step with a movement (PRD addendum 2.3). Incoming stock with a batch
   * code adds to that batch. Outgoing stock with a code must come from that batch; without one it
   * comes from the batches that expire first (FEFO), and untracked stock covers any remainder.
   */
  private async applyBatches(tx: Tx, input: { organizationId: string; warehouseId: string; itemId: string; batchCode?: string; expiresOn?: string }, quantity: Prisma.Decimal) {
    const key = { organizationId: input.organizationId, warehouseId: input.warehouseId, itemId: input.itemId };
    if (quantity.isZero()) return;
    if (quantity.greaterThan(0)) {
      if (!input.batchCode) return;
      const expiresOn = input.expiresOn ? new Date(input.expiresOn) : null;
      await tx.stockBatch.upsert({
        where: { organizationId_warehouseId_itemId_batchCode: { ...key, batchCode: input.batchCode } },
        create: { ...key, batchCode: input.batchCode, expiresOn, onHand: quantity },
        update: { onHand: { increment: quantity }, ...(expiresOn ? { expiresOn } : {}) },
      });
      return;
    }
    let left = quantity.abs();
    if (input.batchCode) {
      const batch = await tx.stockBatch.findUnique({ where: { organizationId_warehouseId_itemId_batchCode: { ...key, batchCode: input.batchCode } } });
      if (!batch || batch.onHand.lessThan(left)) {
        throw new AppError(HttpStatus.CONFLICT, 'insufficient_batch_stock', `Batch ${input.batchCode} has ${batch?.onHand.toString() ?? '0'} in this warehouse`, { itemId: input.itemId, batchCode: input.batchCode });
      }
      await tx.stockBatch.update({ where: { id: batch.id }, data: { onHand: { decrement: left } } });
      return;
    }
    const batches = await tx.stockBatch.findMany({
      where: { ...key, onHand: { gt: 0 } },
      orderBy: [{ expiresOn: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
    });
    for (const batch of batches) {
      if (left.lessThanOrEqualTo(0)) break;
      const take = Decimal.min(left, batch.onHand);
      await tx.stockBatch.update({ where: { id: batch.id }, data: { onHand: { decrement: take } } });
      left = left.minus(take);
    }
  }

  /** Batches with stock, soonest expiry first; `expiringWithinDays` narrows to those expiring by then (expired included). */
  async batches(organizationId: string, filter: { itemId?: string; warehouseId?: string | { in: string[] }; expiringWithinDays?: number }, query: PaginationQueryDto) {
    const { expiringWithinDays, ...rest } = filter;
    const where: Prisma.StockBatchWhereInput = {
      organizationId,
      ...rest,
      onHand: { gt: 0 },
      ...(expiringWithinDays !== undefined ? { expiresOn: { not: null, lte: new Date(Date.now() + expiringWithinDays * 86_400_000) } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.stockBatch.findMany({ where, orderBy: [{ expiresOn: { sort: 'asc', nulls: 'last' } }, { batchCode: 'asc' }], ...skipTake(query) }),
      this.prisma.stockBatch.count({ where }),
    ]);
    const today = new Date(new Date().toISOString().slice(0, 10));
    const items = rows.map((b) => ({
      ...b,
      expiresOn: b.expiresOn?.toISOString().slice(0, 10) ?? null,
      daysToExpiry: b.expiresOn ? Math.round((b.expiresOn.getTime() - today.getTime()) / 86_400_000) : null,
      expired: b.expiresOn ? b.expiresOn < today : false,
    }));
    return toPage(items, total, query);
  }

  /** Corrections are new, opposite entries — the original is never edited (PRD 5.9). */
  /** The warehouse of one of the organization's movements (for location checks), or null. */
  async movementWarehouse(organizationId: string, movementId: string) {
    const m = await this.prisma.stockMovement.findFirst({ where: { id: movementId, organizationId }, select: { warehouseId: true } });
    return m?.warehouseId ?? null;
  }

  async reverse(organizationId: string, movementId: string, createdBy: string, reason: string) {
    const original = await this.prisma.stockMovement.findFirst({ where: { id: movementId, organizationId } });
    if (!original) throw notFound('Movement');
    if (original.type === 'reversal') throw conflict('cannot_reverse_reversal', 'Reverse the original movement instead');
    const reversed = await this.prisma.stockMovement.findUnique({ where: { reversesMovementId: movementId } });
    if (reversed) throw conflict('already_reversed', 'This movement has already been reversed');

    return this.prisma.$transaction(async (tx) => {
      const quantity = original.quantity.negated();
      const balance = await this.lockBalance(tx, organizationId, original.warehouseId, original.itemId);
      const result = applyMovement(balance, 'reversal', quantity);
      if ('error' in result) throw new AppError(HttpStatus.CONFLICT, 'insufficient_stock', result.error);
      await this.saveBalance(tx, organizationId, original.warehouseId, original.itemId, result.next);
      const movement = await tx.stockMovement.create({
        data: {
          organizationId,
          warehouseId: original.warehouseId,
          itemId: original.itemId,
          type: 'reversal',
          quantity,
          unitOfMeasure: original.unitOfMeasure,
          sourceType: 'reversal',
          sourceId: original.id,
          idempotencyKey: `reversal:${original.id}`,
          requestHash: 'reversal',
          reversesMovementId: original.id,
          batchCode: original.batchCode,
          expiresOn: original.expiresOn,
          note: reason,
          createdBy,
        },
      });
      await this.applyBatches(
        tx,
        { organizationId, warehouseId: original.warehouseId, itemId: original.itemId, batchCode: original.batchCode ?? undefined, expiresOn: original.expiresOn?.toISOString().slice(0, 10) },
        quantity,
      );
      await emitEvent(tx, SERVICE_NAME, 'StockMovementPosted', movement.id, {
        movementId: movement.id,
        organizationId,
        warehouseId: movement.warehouseId,
        itemId: movement.itemId,
        type: movement.type,
        quantity: movement.quantity.toString(),
        sourceType: movement.sourceType,
        sourceId: movement.sourceId,
      });
      return movement;
    });
  }

  /**
   * All-or-nothing reservation across the organization's warehouses. Balances
   * are locked in a fixed order (item, then warehouse) so concurrent
   * reservations can't deadlock or both claim the same stock.
   */
  async reserve(request: ReserveStockRequest): Promise<ReserveStockResult> {
    const existing = await this.prisma.stockReservation.findUnique({
      where: { referenceType_referenceId: { referenceType: request.referenceType, referenceId: request.referenceId } },
    });
    if (existing && existing.status !== 'failed') {
      return { reservationId: existing.id, status: existing.status === 'active' || existing.status === 'consumed' ? 'active' : 'failed', shortages: [] };
    }

    return this.prisma.$transaction(async (tx) => {
      const wanted = new Map<string, { quantity: Prisma.Decimal; warehouseId?: string }>();
      for (const line of request.lines) {
        const key = `${line.itemId}|${line.warehouseId ?? ''}`;
        const prior = wanted.get(key);
        wanted.set(key, { quantity: (prior?.quantity ?? new Decimal(0)).plus(line.quantity), warehouseId: line.warehouseId });
      }

      const picks: { itemId: string; warehouseId: string; quantity: Prisma.Decimal }[] = [];
      const shortages: ReserveStockResult['shortages'] = [];
      for (const [key, want] of [...wanted.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const itemId = key.split('|')[0]!;
        const rows = await tx.$queryRaw<{ warehouse_id: string; on_hand: Prisma.Decimal; reserved: Prisma.Decimal; held: Prisma.Decimal }[]>`
          SELECT warehouse_id, on_hand, reserved, damaged + quarantined AS held FROM ${Prisma.raw(qualified('stock_balances'))}
          WHERE organization_id = ${request.organizationId}::uuid AND item_id = ${itemId}::uuid
            ${want.warehouseId ? Prisma.sql`AND warehouse_id = ${want.warehouseId}::uuid` : Prisma.empty}
          ORDER BY warehouse_id
          FOR UPDATE`;
        const candidates = rows.map((r) => ({ warehouseId: r.warehouse_id, available: new Decimal(r.on_hand).minus(r.reserved).minus(r.held) }));
        const allocation = allocate(want.quantity, candidates);
        if (!allocation) {
          const available = candidates.reduce((s, c) => s.plus(Decimal.max(c.available, 0)), new Decimal(0));
          shortages.push({ itemId, requested: want.quantity.toString(), available: available.toString() });
        } else {
          picks.push(...allocation.map((a) => ({ itemId, ...a })));
        }
      }

      const status = shortages.length ? 'failed' : 'active';
      if (status === 'active') {
        for (const p of picks) {
          await tx.$executeRaw`UPDATE ${Prisma.raw(qualified('stock_balances'))} SET reserved = reserved + ${p.quantity}, updated_at = now()
            WHERE organization_id = ${request.organizationId}::uuid AND warehouse_id = ${p.warehouseId}::uuid AND item_id = ${p.itemId}::uuid`;
        }
      }

      const data = {
        organizationId: request.organizationId,
        status,
        shortages: shortages.length ? shortages : Prisma.JsonNull,
      } as const;
      const reservation = existing
        ? await tx.stockReservation.update({ where: { id: existing.id }, data })
        : await tx.stockReservation.create({ data: { ...data, referenceType: request.referenceType, referenceId: request.referenceId } });
      if (status === 'active') {
        await tx.stockReservationLine.createMany({ data: picks.map((p) => ({ reservationId: reservation.id, ...p })) });
      }

      if (request.referenceType === 'order') {
        if (status === 'active') {
          await emitEvent(tx, SERVICE_NAME, 'StockReserved', reservation.id, {
            reservationId: reservation.id,
            organizationId: request.organizationId,
            orderId: request.referenceId,
            lines: picks.map((p) => ({ itemId: p.itemId, warehouseId: p.warehouseId, quantity: p.quantity.toString() })),
          });
        } else {
          await emitEvent(tx, SERVICE_NAME, 'StockReservationFailed', reservation.id, {
            organizationId: request.organizationId,
            orderId: request.referenceId,
            reason: 'insufficient_stock',
            shortages,
          });
        }
      }
      return { reservationId: reservation.id, status, shortages };
    });
  }

  /**
   * A pickup order was handed over: issue whatever its reservation still holds
   * (each line once, by idempotency key), from the reserved warehouses.
   */
  async consumeForHandover(orderId: string) {
    const reservation = await this.prisma.stockReservation.findUnique({
      where: { referenceType_referenceId: { referenceType: 'order', referenceId: orderId } },
      include: { lines: true },
    });
    if (!reservation || reservation.status !== 'active') return { issued: 0 };
    let issued = 0;
    for (const line of reservation.lines) {
      const remaining = line.quantity.minus(line.consumedQuantity);
      if (!remaining.greaterThan(0)) continue;
      await this.post({
        idempotencyKey: `pickup:${orderId}:${line.id}`,
        organizationId: reservation.organizationId,
        warehouseId: line.warehouseId,
        itemId: line.itemId,
        type: 'issue',
        quantity: remaining.negated().toString(),
        sourceType: 'pickup',
        sourceId: orderId,
        reservation: { referenceType: 'order', referenceId: orderId },
        createdBy: 'service:commerce',
      });
      issued++;
    }
    return { issued };
  }

  /** Frees whatever is still held. Safe to call repeatedly. */
  async release(referenceType: string, referenceId: string) {
    return this.prisma.$transaction(async (tx) => {
      const reservation = await tx.stockReservation.findUnique({
        where: { referenceType_referenceId: { referenceType, referenceId } },
        include: { lines: { orderBy: [{ itemId: 'asc' }, { warehouseId: 'asc' }] } },
      });
      if (!reservation || reservation.status !== 'active') return { released: false };
      for (const line of reservation.lines) {
        const remaining = line.quantity.minus(line.consumedQuantity);
        if (!remaining.greaterThan(0)) continue;
        await this.lockBalance(tx, reservation.organizationId, line.warehouseId, line.itemId);
        await tx.$executeRaw`UPDATE ${Prisma.raw(qualified('stock_balances'))} SET reserved = GREATEST(reserved - ${remaining}, 0), updated_at = now()
          WHERE organization_id = ${reservation.organizationId}::uuid AND warehouse_id = ${line.warehouseId}::uuid AND item_id = ${line.itemId}::uuid`;
      }
      await tx.stockReservation.update({ where: { id: reservation.id }, data: { status: 'released' } });
      return { released: true };
    });
  }

  /** Whether an organization keeps stock here at all (organizations that don't are never reserved against). */
  async tracksStock(organizationId: string) {
    return (await this.prisma.stockBalance.count({ where: { organizationId } })) > 0;
  }

  // ---- Queries ---------------------------------------------------------------------

  async balances(organizationId: string, filter: { itemId?: string; warehouseId?: string | { in: string[] } }, query: PaginationQueryDto) {
    const where = { organizationId, ...filter };
    const [items, total] = await Promise.all([
      this.prisma.stockBalance.findMany({ where, orderBy: [{ itemId: 'asc' }, { warehouseId: 'asc' }], ...skipTake(query) }),
      this.prisma.stockBalance.count({ where }),
    ]);
    return toPage(
      items.map((b) => ({ ...b, available: b.onHand.minus(b.reserved).minus(b.damaged).minus(b.quarantined) })),
      total,
      query,
    );
  }

  async movements(organizationId: string, filter: { itemId?: string; warehouseId?: string | { in: string[] } }, query: PaginationQueryDto) {
    const where = { organizationId, ...filter };
    const [items, total] = await Promise.all([
      this.prisma.stockMovement.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        omit: { requestHash: true },
        ...skipTake(query),
      }),
      this.prisma.stockMovement.count({ where }),
    ]);
    return toPage(items, total, query);
  }

  async reservation(organizationId: string, referenceType: string, referenceId: string) {
    const reservation = await this.prisma.stockReservation.findFirst({
      where: { organizationId, referenceType, referenceId },
      include: { lines: true },
    });
    if (!reservation) throw notFound('Reservation');
    return reservation;
  }

  // ---- Locking -----------------------------------------------------------------------

  async lockBalance(tx: Tx, organizationId: string, warehouseId: string, itemId: string): Promise<BalanceState & { damaged: Prisma.Decimal; quarantined: Prisma.Decimal }> {
    await tx.$executeRaw`INSERT INTO ${Prisma.raw(qualified('stock_balances'))} (organization_id, warehouse_id, item_id, updated_at)
      VALUES (${organizationId}::uuid, ${warehouseId}::uuid, ${itemId}::uuid, now()) ON CONFLICT DO NOTHING`;
    const [row] = await tx.$queryRaw<{ on_hand: Prisma.Decimal; reserved: Prisma.Decimal; damaged: Prisma.Decimal; quarantined: Prisma.Decimal }[]>`
      SELECT on_hand, reserved, damaged, quarantined FROM ${Prisma.raw(qualified('stock_balances'))}
      WHERE organization_id = ${organizationId}::uuid AND warehouse_id = ${warehouseId}::uuid AND item_id = ${itemId}::uuid
      FOR UPDATE`;
    const damaged = new Decimal(row!.damaged);
    const quarantined = new Decimal(row!.quarantined);
    return { onHand: new Decimal(row!.on_hand), reserved: new Decimal(row!.reserved), damaged, quarantined, held: damaged.plus(quarantined) };
  }

  private saveBalance(tx: Tx, organizationId: string, warehouseId: string, itemId: string, next: BalanceState) {
    return tx.stockBalance.update({
      where: { organizationId_warehouseId_itemId: { organizationId, warehouseId, itemId } },
      data: { onHand: next.onHand, reserved: next.reserved },
    });
  }

  private replay(movementId: string, storedHash: string, requestHash: string) {
    if (storedHash !== requestHash) {
      throw new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'idempotency_key_reused', 'This idempotency key was used for a different movement');
    }
    return { movementId, replayed: true };
  }
}

const stringify = (b: BalanceState) => ({ onHand: b.onHand.toString(), reserved: b.reserved.toString() });
