import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  type ActingOrganization,
  AppError,
  badRequest,
  conflict,
  emitEvent,
  InventoryClient,
  notFound,
  type PaginationQueryDto,
  requireRole,
  skipTake,
  toPage,
  WarehousesClient,
} from '@uboce/common';

import { SERVICE_NAME } from '../config.js';
import { Prisma } from '../generated/prisma/client.js';
import type { CroppingSeason } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma.service.js';
import { harvestRemaining, newLotCode, type TraceNode, validateSplit } from './lineage.js';

const { Decimal } = Prisma;
type Tx = Prisma.TransactionClient;
type Lot = Prisma.ProduceLotGetPayload<object>;

const FARM_ROLES = ['owner', 'admin', 'farmer'];
const LOT_ROLES = ['owner', 'admin', 'farmer', 'warehouse_operator', 'quality_inspector'];
const READ_ROLES = [...LOT_ROLES, 'sales_representative', 'procurement_officer', 'auditor', 'manufacturer'];

@Injectable()
export class AgricultureService {
  private readonly logger = new Logger(AgricultureService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryClient,
    private readonly warehouses: WarehousesClient,
  ) {}

  // ---- Farms, seasons, harvests ---------------------------------------------------

  createFarm(org: ActingOrganization, dto: { name: string; memberUserId?: string; region?: string; zone?: string; woreda?: string; latitude?: string; longitude?: string; areaHectares?: string }) {
    requireRole(org, FARM_ROLES, 'register farms');
    return this.prisma.farm.create({ data: { ...dto, organizationId: org.organization.id } });
  }

  async listFarms(org: ActingOrganization, query: PaginationQueryDto) {
    requireRole(org, READ_ROLES, 'view farms');
    const where = { organizationId: org.organization.id };
    const [items, total] = await Promise.all([
      this.prisma.farm.findMany({ where, include: { plots: true }, orderBy: { createdAt: 'desc' }, ...skipTake(query) }),
      this.prisma.farm.count({ where }),
    ]);
    return toPage(items, total, query);
  }

  async addPlot(org: ActingOrganization, farmId: string, dto: { name: string; areaHectares?: string }) {
    requireRole(org, FARM_ROLES, 'manage plots');
    await this.farm(org, farmId);
    return this.prisma.farmPlot.create({ data: { ...dto, farmId } });
  }

  async createSeason(
    org: ActingOrganization,
    dto: { farmId: string; plotId?: string; crop: string; year: number; season: CroppingSeason; plantedAt?: string; expectedHarvestQuantity?: string; unitOfMeasure: string },
  ) {
    requireRole(org, FARM_ROLES, 'plan seasons');
    const farm = await this.farm(org, dto.farmId);
    if (dto.plotId && !farm.plots.some((p) => p.id === dto.plotId)) throw badRequest('unknown_plot', 'That plot is not on this farm');
    return this.prisma.productionSeason.create({
      data: { ...dto, crop: dto.crop.trim().toLowerCase(), plantedAt: dto.plantedAt ? new Date(dto.plantedAt) : null, organizationId: org.organization.id },
    });
  }

  async recordHarvest(org: ActingOrganization, userId: string, seasonId: string, dto: { harvestedAt: string; quantity: string; notes?: string }) {
    requireRole(org, FARM_ROLES, 'record harvests');
    const season = await this.prisma.productionSeason.findFirst({ where: { id: seasonId, organizationId: org.organization.id } });
    if (!season) throw notFound('Season');
    return this.prisma.harvestRecord.create({
      data: {
        seasonId,
        organizationId: org.organization.id,
        harvestedAt: new Date(dto.harvestedAt),
        quantity: dto.quantity,
        unitOfMeasure: season.unitOfMeasure,
        notes: dto.notes,
        recordedByUserId: userId,
      },
    });
  }

  // ---- Lots ---------------------------------------------------------------------

  /** Aggregates (parts of) harvests into one uniquely identified lot (PRD 6.4). */
  async lotFromHarvests(
    org: ActingOrganization,
    userId: string,
    dto: { harvests: { harvestId: string; quantity: string }[]; productId?: string; grade?: string; warehouseId?: string },
  ) {
    requireRole(org, LOT_ROLES, 'create lots');
    if (dto.warehouseId) await this.ownWarehouse(org, dto.warehouseId);

    const lot = await this.prisma.$transaction(async (tx) => {
      const harvests = await tx.harvestRecord.findMany({
        where: { id: { in: dto.harvests.map((h) => h.harvestId) }, organizationId: org.organization.id },
        include: { season: true },
      });
      if (harvests.length !== new Set(dto.harvests.map((h) => h.harvestId)).size) throw badRequest('unknown_harvest', 'Some harvests are not yours');
      const crops = new Set(harvests.map((h) => h.season.crop));
      const units = new Set(harvests.map((h) => h.unitOfMeasure));
      if (crops.size > 1 || units.size > 1) throw badRequest('mixed_harvests', 'A lot holds one crop in one unit');

      for (const want of dto.harvests) {
        const harvest = harvests.find((h) => h.id === want.harvestId)!;
        // Lock-free but safe: the read and insert happen in one serializable-enough tx per harvest row.
        await tx.$queryRaw`SELECT id FROM harvest_records WHERE id = ${harvest.id}::uuid FOR UPDATE`;
        const used = await tx.lotSource.findMany({ where: { harvestId: harvest.id }, select: { quantity: true } });
        const left = harvestRemaining(harvest.quantity, used.map((u) => u.quantity));
        if (new Decimal(want.quantity).greaterThan(left)) {
          throw badRequest('over_allocation', `Only ${left.toString()} ${harvest.unitOfMeasure} of harvest ${harvest.id} is unassigned`);
        }
      }

      const total = dto.harvests.reduce((s, h) => s.plus(h.quantity), new Decimal(0));
      const created = await tx.produceLot.create({
        data: {
          lotCode: newLotCode(),
          organizationId: org.organization.id,
          crop: [...crops][0]!,
          productId: dto.productId,
          quantity: total,
          originalQuantity: total,
          unitOfMeasure: [...units][0]!,
          grade: dto.grade,
          warehouseId: dto.warehouseId,
          origin: 'harvest_aggregation',
          createdByUserId: userId,
          sources: { create: dto.harvests.map((h) => ({ harvestId: h.harvestId, quantity: h.quantity })) },
        },
      });
      await this.queueReceipt(tx, created);
      await this.announce(tx, created, []);
      return created;
    });
    await this.flush();
    return lot;
  }

  /** Splits one lot into several; the parent keeps whatever isn't split off. */
  async split(org: ActingOrganization, userId: string, lotId: string, parts: string[]) {
    requireRole(org, LOT_ROLES, 'split lots');
    const children = await this.prisma.$transaction(async (tx) => {
      const parent = await this.lockedLot(tx, org, lotId);
      const problem = validateSplit(parent.quantity, parts);
      if (problem) throw new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'invalid_split', problem);

      const created: Lot[] = [];
      for (const part of parts) {
        const child = await tx.produceLot.create({
          data: {
            lotCode: newLotCode(),
            organizationId: parent.organizationId,
            crop: parent.crop,
            productId: parent.productId,
            quantity: part,
            originalQuantity: part,
            unitOfMeasure: parent.unitOfMeasure,
            grade: parent.grade,
            warehouseId: parent.warehouseId,
            origin: 'split',
            createdByUserId: userId,
            sources: { create: { parentLotId: parent.id, quantity: part } },
          },
        });
        await this.queueTransfer(tx, parent, child, new Decimal(part));
        await this.announce(tx, child, [parent.id]);
        created.push(child);
      }
      const left = parts.reduce((s, p) => s.minus(p), parent.quantity);
      await tx.produceLot.update({ where: { id: parent.id }, data: { quantity: left, status: left.greaterThan(0) ? 'active' : 'depleted' } });
      return created;
    });
    await this.flush();
    return children;
  }

  /** Merges whole lots (same crop, unit and warehouse) into a new one. */
  async merge(org: ActingOrganization, userId: string, lotIds: string[], grade?: string) {
    requireRole(org, LOT_ROLES, 'merge lots');
    if (new Set(lotIds).size < 2) throw badRequest('merge_needs_two', 'Merge at least two different lots');
    const merged = await this.prisma.$transaction(async (tx) => {
      const parents: Lot[] = [];
      for (const id of [...lotIds].sort()) parents.push(await this.lockedLot(tx, org, id));
      const key = (l: Lot) => `${l.crop}|${l.unitOfMeasure}|${l.warehouseId ?? ''}`;
      if (new Set(parents.map(key)).size !== 1) throw badRequest('incompatible_lots', 'Merged lots must share crop, unit and warehouse');
      const total = parents.reduce((s, p) => s.plus(p.quantity), new Decimal(0));
      const first = parents[0]!;
      const child = await tx.produceLot.create({
        data: {
          lotCode: newLotCode(),
          organizationId: first.organizationId,
          crop: first.crop,
          productId: first.productId,
          quantity: total,
          originalQuantity: total,
          unitOfMeasure: first.unitOfMeasure,
          grade: grade ?? (new Set(parents.map((p) => p.grade)).size === 1 ? first.grade : null),
          warehouseId: first.warehouseId,
          origin: 'merge',
          createdByUserId: userId,
          sources: { create: parents.map((p) => ({ parentLotId: p.id, quantity: p.quantity })) },
        },
      });
      for (const p of parents) {
        await this.queueTransfer(tx, p, child, p.quantity);
        await tx.produceLot.update({ where: { id: p.id }, data: { quantity: 0, status: 'depleted' } });
      }
      await this.announce(tx, child, parents.map((p) => p.id));
      return child;
    });
    await this.flush();
    return merged;
  }

  async grade(org: ActingOrganization, userId: string, lotId: string, dto: { grade: string; moisturePct?: string; defectCount?: number; notes?: string }) {
    requireRole(org, LOT_ROLES, 'grade lots');
    await this.lot(org, lotId);
    return this.prisma.$transaction(async (tx) => {
      await tx.gradingRecord.create({ data: { ...dto, lotId, gradedByUserId: userId } });
      return tx.produceLot.update({ where: { id: lotId }, data: { grade: dto.grade }, include: { gradings: true } });
    });
  }

  async listLots(org: ActingOrganization, status: 'active' | 'depleted' | undefined, query: PaginationQueryDto) {
    requireRole(org, READ_ROLES, 'view lots');
    const where = { organizationId: org.organization.id, ...(status ? { status } : {}) };
    const [items, total] = await Promise.all([
      this.prisma.produceLot.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(query) }),
      this.prisma.produceLot.count({ where }),
    ]);
    return toPage(items, total, query);
  }

  /** Full ancestry: parent lots recursively, down to harvests, seasons and farms (PRD 6.4). */
  async trace(org: ActingOrganization, lotId: string): Promise<TraceNode> {
    requireRole(org, READ_ROLES, 'view lots');
    await this.lot(org, lotId);
    const visit = async (id: string, depth: number): Promise<TraceNode> => {
      if (depth > 50) throw conflict('lineage_too_deep', 'Lineage deeper than 50 levels');
      const lot = await this.prisma.produceLot.findUniqueOrThrow({ where: { id }, include: { sources: true } });
      const parents = await Promise.all(
        lot.sources.filter((s) => s.parentLotId).map(async (s) => ({ quantity: s.quantity.toString(), lot: await visit(s.parentLotId!, depth + 1) })),
      );
      const harvestSources = lot.sources.filter((s) => s.harvestId);
      const harvests = await this.prisma.harvestRecord.findMany({
        where: { id: { in: harvestSources.map((s) => s.harvestId!) } },
        include: { season: { include: { farm: true } } },
      });
      return {
        lotId: lot.id,
        lotCode: lot.lotCode,
        quantity: lot.originalQuantity.toString(),
        origin: lot.origin,
        grade: lot.grade,
        parents,
        harvests: harvestSources.map((s) => {
          const h = harvests.find((x) => x.id === s.harvestId)!;
          return {
            quantity: s.quantity.toString(),
            harvestId: h.id,
            harvestedAt: h.harvestedAt.toISOString(),
            crop: h.season.crop,
            season: h.season.season,
            year: h.season.year,
            farm: { id: h.season.farm.id, name: h.season.farm.name, region: h.season.farm.region },
          };
        }),
      };
    };
    return visit(lotId, 0);
  }

  // ---- Stock postings to Inventory --------------------------------------------------

  /** Posts every owed stock change; failures stay queued for the retry job. */
  async flush(limit = 100) {
    const pending = await this.prisma.stockPosting.findMany({ where: { postedAt: null }, orderBy: { createdAt: 'asc' }, take: limit });
    for (const p of pending) {
      try {
        await this.inventory.postMovement({
          idempotencyKey: p.idempotencyKey,
          organizationId: p.organizationId,
          warehouseId: p.warehouseId,
          itemId: p.lotId,
          type: p.type as 'receipt' | 'issue',
          quantity: p.quantity.toString(),
          unitOfMeasure: p.unitOfMeasure,
          sourceType: 'produce_lot',
          sourceId: p.lotId,
        });
        await this.prisma.stockPosting.update({ where: { id: p.id }, data: { postedAt: new Date() } });
      } catch (error) {
        await this.prisma.stockPosting.update({ where: { id: p.id }, data: { attempts: { increment: 1 }, lastError: String(error).slice(0, 500) } });
        this.logger.warn(`Stock posting ${p.idempotencyKey} failed; will retry`);
      }
    }
    return pending.length;
  }

  private queueReceipt(tx: Tx, lot: Lot) {
    if (!lot.warehouseId) return Promise.resolve();
    return tx.stockPosting.create({
      data: {
        organizationId: lot.organizationId,
        lotId: lot.id,
        warehouseId: lot.warehouseId,
        type: 'receipt',
        quantity: lot.quantity,
        unitOfMeasure: lot.unitOfMeasure,
        idempotencyKey: `produce-lot:${lot.id}:receipt`,
      },
    });
  }

  /** Stock moves from parent lot to child lot in the same warehouse. */
  private async queueTransfer(tx: Tx, parent: Lot, child: Lot, quantity: Prisma.Decimal) {
    if (!parent.warehouseId) return;
    await tx.stockPosting.createMany({
      data: [
        {
          organizationId: parent.organizationId,
          lotId: parent.id,
          warehouseId: parent.warehouseId,
          type: 'issue',
          quantity: quantity.negated(),
          unitOfMeasure: parent.unitOfMeasure,
          idempotencyKey: `produce-lot:${parent.id}:to:${child.id}`,
        },
        {
          organizationId: child.organizationId,
          lotId: child.id,
          warehouseId: parent.warehouseId,
          type: 'receipt',
          quantity,
          unitOfMeasure: child.unitOfMeasure,
          idempotencyKey: `produce-lot:${child.id}:from:${parent.id}`,
        },
      ],
    });
  }

  private announce(tx: Tx, lot: Lot, parentLotIds: string[]) {
    return emitEvent(tx, SERVICE_NAME, 'ProduceLotCreated', lot.id, {
      lotId: lot.id,
      lotCode: lot.lotCode,
      organizationId: lot.organizationId,
      productId: lot.productId,
      crop: lot.crop,
      quantity: lot.quantity.toString(),
      unitOfMeasure: lot.unitOfMeasure,
      grade: lot.grade,
      warehouseId: lot.warehouseId,
      parentLotIds,
    });
  }

  private async lockedLot(tx: Tx, org: ActingOrganization, lotId: string) {
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM produce_lots WHERE id = ${lotId}::uuid AND organization_id = ${org.organization.id}::uuid FOR UPDATE`;
    if (!row) throw notFound('Lot');
    const lot = await tx.produceLot.findUniqueOrThrow({ where: { id: lotId } });
    if (lot.status !== 'active' || !lot.quantity.greaterThan(0)) throw conflict('lot_depleted', `Lot ${lot.lotCode} has nothing left`);
    return lot;
  }

  private async lot(org: ActingOrganization, lotId: string) {
    const lot = await this.prisma.produceLot.findFirst({ where: { id: lotId, organizationId: org.organization.id } });
    if (!lot) throw notFound('Lot');
    return lot;
  }

  private async farm(org: ActingOrganization, farmId: string) {
    const farm = await this.prisma.farm.findFirst({ where: { id: farmId, organizationId: org.organization.id }, include: { plots: true } });
    if (!farm) throw notFound('Farm');
    return farm;
  }

  private async ownWarehouse(org: ActingOrganization, warehouseId: string) {
    const w = await this.warehouses.get(warehouseId);
    if (!w || w.organizationId !== org.organization.id) throw badRequest('unknown_warehouse', 'Warehouse not found in your organization');
  }
}
