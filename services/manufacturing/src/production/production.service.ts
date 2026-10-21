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
import { PrismaService } from '../prisma.service.js';
import { newBatchCode, requiredMaterials, yieldPercent } from './rules.js';

const { Decimal } = Prisma;
const PRODUCTION_ROLES = ['owner', 'admin', 'manufacturer'];
const READ_ROLES = [...PRODUCTION_ROLES, 'warehouse_operator', 'quality_inspector', 'sales_representative', 'auditor'];
const orderInclude = { bom: { include: { components: true } }, runs: { include: { consumptions: true, batch: true } } } as const;

@Injectable()
export class ProductionService {
  private readonly logger = new Logger(ProductionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryClient,
    private readonly warehouses: WarehousesClient,
  ) {}

  createBom(
    org: ActingOrganization,
    dto: { name: string; outputItemId: string; outputQuantity: string; unitOfMeasure: string; components: { itemId: string; description: string; quantity: string; unitOfMeasure: string }[] },
  ) {
    requireRole(org, PRODUCTION_ROLES, 'define bills of materials');
    if (new Set(dto.components.map((c) => c.itemId)).size !== dto.components.length) throw badRequest('duplicate_component', 'List each material once');
    if (dto.components.some((c) => c.itemId === dto.outputItemId)) throw badRequest('circular_bom', 'A recipe cannot consume its own output');
    const { components, ...bom } = dto;
    return this.prisma.billOfMaterials.create({
      data: { ...bom, organizationId: org.organization.id, components: { create: components } },
      include: { components: true },
    });
  }

  async listBoms(org: ActingOrganization, query: PaginationQueryDto) {
    requireRole(org, READ_ROLES, 'view bills of materials');
    const where = { organizationId: org.organization.id, status: 'active' as const };
    const [items, total] = await Promise.all([
      this.prisma.billOfMaterials.findMany({ where, include: { components: true }, orderBy: { createdAt: 'desc' }, ...skipTake(query) }),
      this.prisma.billOfMaterials.count({ where }),
    ]);
    return toPage(items, total, query);
  }

  async createOrder(org: ActingOrganization, userId: string, dto: { bomId: string; plannedOutput: string; warehouseId: string }) {
    requireRole(org, PRODUCTION_ROLES, 'plan production');
    const bom = await this.prisma.billOfMaterials.findFirst({ where: { id: dto.bomId, organizationId: org.organization.id, status: 'active' } });
    if (!bom) throw notFound('Bill of materials');
    const warehouse = await this.warehouses.get(dto.warehouseId);
    if (!warehouse || warehouse.organizationId !== org.organization.id) throw badRequest('unknown_warehouse', 'Warehouse not found in your organization');
    return this.prisma.productionOrder.create({ data: { ...dto, organizationId: org.organization.id, createdByUserId: userId }, include: orderInclude });
  }

  /** Reserves the scaled materials in the production warehouse (PRD 6.5); all-or-nothing. */
  async release(org: ActingOrganization, orderId: string) {
    requireRole(org, PRODUCTION_ROLES, 'release production');
    const order = await this.owned(org, orderId);
    if (order.status !== 'planned') throw conflict('invalid_transition', `A ${order.status} production order cannot be released`);
    const materials = requiredMaterials(order.bom, order.plannedOutput);
    const result = await this.inventory.reserve({
      organizationId: order.organizationId,
      referenceType: 'production_order',
      referenceId: order.id,
      lines: materials.map((m) => ({ itemId: m.itemId, quantity: m.quantity.toString(), warehouseId: order.warehouseId })),
    });
    if (result.status !== 'active') {
      throw new AppError(HttpStatus.CONFLICT, 'insufficient_materials', 'Not enough materials in the production warehouse', result.shortages);
    }
    await this.prisma.productionOrder.update({ where: { id: orderId }, data: { status: 'released', releasedAt: new Date() } });
    return this.owned(org, orderId);
  }

  /**
   * Records what was actually consumed and produced. Stock postings are queued
   * in the same transaction and sent with fixed idempotency keys; materials
   * come out of the order's reservation, and the leftover hold is released.
   */
  async complete(
    org: ActingOrganization,
    userId: string,
    orderId: string,
    dto: { outputQuantity: string; wasteQuantity?: string; notes?: string; consumptions?: { itemId: string; quantity: string }[] },
  ) {
    requireRole(org, PRODUCTION_ROLES, 'record production');
    const order = await this.owned(org, orderId);
    if (order.status !== 'released') throw conflict('invalid_transition', `A ${order.status} production order cannot be completed`);
    const output = new Decimal(dto.outputQuantity);
    if (!output.greaterThan(0)) throw badRequest('no_output', 'Output must be positive');

    // Default to the planned materials; allow recording actuals instead.
    const planned = requiredMaterials(order.bom, order.plannedOutput);
    const consumptions = dto.consumptions ?? planned.map((m) => ({ itemId: m.itemId, quantity: m.quantity.toString() }));
    const recipeItems = new Set(order.bom.components.map((c) => c.itemId));
    if (consumptions.some((c) => !recipeItems.has(c.itemId))) throw badRequest('unknown_material', 'Consumptions must be recipe materials');

    const result = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.productionOrder.updateMany({
        where: { id: orderId, status: 'released' },
        data: { status: 'completed', completedAt: new Date(), releasePending: true },
      });
      if (count === 0) throw conflict('concurrent_change', 'The production order changed; reload and try again');

      const run = await tx.productionRun.create({
        data: {
          productionOrderId: orderId,
          outputQuantity: output,
          wasteQuantity: dto.wasteQuantity ?? '0',
          notes: dto.notes,
          recordedByUserId: userId,
          consumptions: { create: consumptions },
        },
      });
      const batch = await tx.batch.create({
        data: { batchCode: newBatchCode(), organizationId: order.organizationId, itemId: order.bom.outputItemId, quantity: output, runId: run.id },
      });

      await tx.stockPosting.createMany({
        data: [
          ...consumptions.map((c, i) => ({
            organizationId: order.organizationId,
            productionOrderId: orderId,
            warehouseId: order.warehouseId,
            itemId: c.itemId,
            type: 'production_issue',
            quantity: new Decimal(c.quantity).negated(),
            idempotencyKey: `production:${run.id}:in:${i}`,
          })),
          {
            organizationId: order.organizationId,
            productionOrderId: orderId,
            warehouseId: order.warehouseId,
            itemId: order.bom.outputItemId,
            type: 'production_output',
            quantity: output,
            idempotencyKey: `production:${run.id}:out`,
          },
        ],
      });

      await emitEvent(tx, SERVICE_NAME, 'ProductionCompleted', orderId, {
        productionOrderId: orderId,
        runId: run.id,
        organizationId: order.organizationId,
        outputItemId: order.bom.outputItemId,
        outputQuantity: output.toString(),
        batchId: batch.id,
        batchCode: batch.batchCode,
        wasteQuantity: new Decimal(dto.wasteQuantity ?? '0').toString(),
      });
      return { runId: run.id, batch };
    });

    await this.flush();
    const completed = await this.owned(org, orderId);
    return { ...completed, yieldPercent: yieldPercent(output, order.plannedOutput).toString(), batch: result.batch };
  }

  async cancel(org: ActingOrganization, orderId: string) {
    requireRole(org, PRODUCTION_ROLES, 'cancel production');
    const order = await this.owned(org, orderId);
    if (order.status !== 'planned' && order.status !== 'released') throw conflict('invalid_transition', `A ${order.status} production order cannot be cancelled`);
    if (order.status === 'released') await this.inventory.release('production_order', orderId);
    await this.prisma.productionOrder.update({ where: { id: orderId }, data: { status: 'cancelled' } });
    return this.owned(org, orderId);
  }

  async listOrders(org: ActingOrganization, query: PaginationQueryDto) {
    requireRole(org, READ_ROLES, 'view production');
    const where = { organizationId: org.organization.id };
    const [items, total] = await Promise.all([
      this.prisma.productionOrder.findMany({ where, include: orderInclude, orderBy: { createdAt: 'desc' }, ...skipTake(query) }),
      this.prisma.productionOrder.count({ where }),
    ]);
    return toPage(items, total, query);
  }

  getOrder(org: ActingOrganization, orderId: string) {
    requireRole(org, READ_ROLES, 'view production');
    return this.owned(org, orderId);
  }

  /** Input-to-output lineage of a batch (PRD 5.12). */
  async traceBatch(org: ActingOrganization, batchId: string) {
    requireRole(org, READ_ROLES, 'view production');
    const batch = await this.prisma.batch.findFirst({
      where: { id: batchId, organizationId: org.organization.id },
      include: { run: { include: { consumptions: true, order: { include: { bom: true } } } } },
    });
    if (!batch) throw notFound('Batch');
    return {
      batchId: batch.id,
      batchCode: batch.batchCode,
      itemId: batch.itemId,
      quantity: batch.quantity.toString(),
      producedAt: batch.createdAt,
      productionOrderId: batch.run.productionOrderId,
      recipe: batch.run.order.bom.name,
      wasteQuantity: batch.run.wasteQuantity.toString(),
      inputs: batch.run.consumptions.map((c) => ({ itemId: c.itemId, quantity: c.quantity.toString() })),
    };
  }

  /** Sends queued stock postings; then releases what's left of finished orders' reservations. */
  async flush(limit = 200) {
    const pending = await this.prisma.stockPosting.findMany({ where: { postedAt: null }, orderBy: { createdAt: 'asc' }, take: limit });
    for (const p of pending) {
      try {
        await this.inventory.postMovement({
          idempotencyKey: p.idempotencyKey,
          organizationId: p.organizationId,
          warehouseId: p.warehouseId,
          itemId: p.itemId,
          type: p.type as 'production_issue' | 'production_output',
          quantity: p.quantity.toString(),
          sourceType: 'production_order',
          sourceId: p.productionOrderId,
          ...(p.type === 'production_issue' ? { reservation: { referenceType: 'production_order' as const, referenceId: p.productionOrderId } } : {}),
        });
        await this.prisma.stockPosting.update({ where: { id: p.id }, data: { postedAt: new Date() } });
      } catch (error) {
        await this.prisma.stockPosting.update({ where: { id: p.id }, data: { attempts: { increment: 1 }, lastError: String(error).slice(0, 500) } });
        this.logger.warn(`Stock posting ${p.idempotencyKey} failed; will retry`);
      }
    }

    const finished = await this.prisma.productionOrder.findMany({ where: { releasePending: true }, select: { id: true } });
    for (const { id } of finished) {
      const outstanding = await this.prisma.stockPosting.count({ where: { productionOrderId: id, postedAt: null } });
      if (outstanding > 0) continue;
      await this.inventory.release('production_order', id);
      await this.prisma.productionOrder.update({ where: { id }, data: { releasePending: false } });
    }
    return pending.length;
  }

  private async owned(org: ActingOrganization, orderId: string) {
    const order = await this.prisma.productionOrder.findFirst({ where: { id: orderId, organizationId: org.organization.id }, include: orderInclude });
    if (!order) throw notFound('Production order');
    return order;
  }
}
