import { HttpStatus, Injectable } from '@nestjs/common';
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
} from '@uboce/common';
import type { InternalWarehouse } from '@uboce/contracts';

import { SERVICE_NAME } from '../config.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma.service.js';

const { Decimal } = Prisma;
type Tx = Prisma.TransactionClient;

export const WAREHOUSE_ROLES = ['owner', 'admin', 'warehouse_operator'];
const READ_ROLES = [...WAREHOUSE_ROLES, 'logistics_operator', 'quality_inspector', 'procurement_officer', 'manufacturer', 'farmer', 'auditor'];

export interface ReceiptLineInput {
  itemId: string;
  orderLineId?: string;
  description: string;
  expectedQuantity?: string;
  receivedQuantity: string;
  rejectedQuantity?: string;
  discrepancyNote?: string;
}

export interface ReceiptInput {
  warehouseId: string;
  orderId?: string;
  shipmentId?: string;
  inspectionRequired: boolean;
  notes?: string;
  lines: ReceiptLineInput[];
}

const receiptInclude = { lines: { orderBy: { lineNumber: 'asc' } } } as const;

@Injectable()
export class WarehouseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryClient,
  ) {}

  // ---- Warehouses & locations ------------------------------------------------------

  async createWarehouse(org: ActingOrganization, dto: { code: string; name: string; countryCode?: string; region?: string; city?: string; addressLine?: string }) {
    requireRole(org, ['owner', 'admin'], 'create warehouses');
    try {
      return await this.prisma.warehouse.create({ data: { ...dto, countryCode: dto.countryCode ?? 'ET', organizationId: org.organization.id } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw conflict('code_taken', 'Warehouse code already used');
      throw error;
    }
  }

  async listWarehouses(org: ActingOrganization, query: PaginationQueryDto) {
    requireRole(org, READ_ROLES, 'view warehouses');
    const where = { organizationId: org.organization.id };
    const [items, total] = await Promise.all([
      this.prisma.warehouse.findMany({ where, include: { locations: true }, orderBy: { code: 'asc' }, ...skipTake(query) }),
      this.prisma.warehouse.count({ where }),
    ]);
    return toPage(items, total, query);
  }

  async addLocation(org: ActingOrganization, warehouseId: string, dto: { code: string; description?: string }) {
    requireRole(org, WAREHOUSE_ROLES, 'manage locations');
    await this.owned(org, warehouseId);
    try {
      return await this.prisma.storageLocation.create({ data: { ...dto, warehouseId } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw conflict('code_taken', 'Location code already used');
      throw error;
    }
  }

  async internalGet(warehouseId: string): Promise<InternalWarehouse> {
    const w = await this.prisma.warehouse.findUnique({ where: { id: warehouseId } });
    if (!w) throw notFound('Warehouse');
    return { id: w.id, organizationId: w.organizationId, name: w.name, status: w.status };
  }

  // ---- Receiving --------------------------------------------------------------------

  /**
   * Records what arrived (full or partial, with dock rejections). Without
   * inspection, accepted quantities go straight into stock; with it, they wait
   * for Quality's decision (PRD 6.3).
   */
  async receive(org: ActingOrganization, userId: string, input: ReceiptInput) {
    requireRole(org, WAREHOUSE_ROLES, 'receive goods');
    const warehouse = await this.owned(org, input.warehouseId);
    if (warehouse.status !== 'active') throw conflict('warehouse_inactive', 'This warehouse is inactive');
    for (const l of input.lines) {
      if (new Decimal(l.rejectedQuantity ?? '0').greaterThan(l.receivedQuantity)) {
        throw badRequest('invalid_quantities', `Line "${l.description}": rejected cannot exceed received`);
      }
    }

    const receipt = await this.prisma.$transaction(async (tx) => {
      const created = await tx.receipt.create({
        data: {
          organizationId: org.organization.id,
          warehouseId: input.warehouseId,
          orderId: input.orderId,
          shipmentId: input.shipmentId,
          inspectionRequired: input.inspectionRequired,
          status: input.inspectionRequired ? 'pending_inspection' : 'posted',
          notes: input.notes,
          receivedByUserId: userId,
          lines: {
            create: input.lines.map((l, i) => ({
              lineNumber: i + 1,
              itemId: l.itemId,
              orderLineId: l.orderLineId,
              description: l.description,
              expectedQuantity: l.expectedQuantity,
              receivedQuantity: l.receivedQuantity,
              rejectedQuantity: l.rejectedQuantity ?? '0',
              discrepancyNote: l.discrepancyNote,
            })),
          },
        },
        include: receiptInclude,
      });
      await this.announce(tx, created);
      return created;
    });

    if (!input.inspectionRequired) {
      return this.post(receipt.id, receipt.lines.map((l) => ({ lineId: l.id, accepted: l.receivedQuantity.minus(l.rejectedQuantity) })));
    }
    return receipt;
  }

  /** Called when Quality decides on a receipt: accepted quantities enter stock. */
  async applyInspection(receiptId: string, inspectionId: string, accepted: Map<string, Prisma.Decimal>) {
    const receipt = await this.prisma.receipt.findUnique({ where: { id: receiptId }, include: receiptInclude });
    if (!receipt || receipt.status !== 'pending_inspection') return;
    await this.prisma.receipt.update({ where: { id: receiptId }, data: { inspectionId } });

    // Spread each item's accepted total over that item's lines, in order.
    const remaining = new Map(accepted);
    const perLine = receipt.lines.map((l) => {
      const want = l.receivedQuantity.minus(l.rejectedQuantity);
      const pool = remaining.get(l.itemId) ?? new Decimal(0);
      const take = Decimal.min(want, pool);
      remaining.set(l.itemId, pool.minus(take));
      return { lineId: l.id, accepted: take };
    });
    await this.post(receiptId, perLine);
  }

  /** Posts accepted quantities to Inventory, one idempotent movement per line, then marks the receipt posted. */
  private async post(receiptId: string, lines: { lineId: string; accepted: Prisma.Decimal }[]) {
    const receipt = await this.prisma.receipt.findUniqueOrThrow({ where: { id: receiptId }, include: receiptInclude });
    for (const { lineId, accepted } of lines) {
      const line = receipt.lines.find((l) => l.id === lineId)!;
      if (accepted.greaterThan(0)) {
        await this.inventory.postMovement({
          idempotencyKey: `receipt:${receiptId}:${line.lineNumber}`,
          organizationId: receipt.organizationId,
          warehouseId: receipt.warehouseId,
          itemId: line.itemId,
          type: 'receipt',
          quantity: accepted.toString(),
          sourceType: 'receipt',
          sourceId: receiptId,
        });
      }
      await this.prisma.receiptLine.update({ where: { id: lineId }, data: { acceptedQuantity: accepted } });
    }
    return this.prisma.receipt.update({ where: { id: receiptId }, data: { status: 'posted', postedAt: new Date() }, include: receiptInclude });
  }

  async listReceipts(org: ActingOrganization, query: PaginationQueryDto) {
    requireRole(org, READ_ROLES, 'view receipts');
    const where = { organizationId: org.organization.id };
    const [items, total] = await Promise.all([
      this.prisma.receipt.findMany({ where, include: receiptInclude, orderBy: { createdAt: 'desc' }, ...skipTake(query) }),
      this.prisma.receipt.count({ where }),
    ]);
    return toPage(items, total, query);
  }

  async getReceipt(org: ActingOrganization, receiptId: string) {
    requireRole(org, READ_ROLES, 'view receipts');
    const receipt = await this.prisma.receipt.findFirst({ where: { id: receiptId, organizationId: org.organization.id }, include: receiptInclude });
    if (!receipt) throw notFound('Receipt');
    return receipt;
  }

  // ---- Transfers ----------------------------------------------------------------------

  /** Two ledger legs with fixed idempotency keys, so a retried transfer finishes instead of doubling. */
  async transfer(org: ActingOrganization, userId: string, dto: { fromWarehouseId: string; toWarehouseId: string; itemId: string; quantity: string }) {
    requireRole(org, WAREHOUSE_ROLES, 'transfer stock');
    if (dto.fromWarehouseId === dto.toWarehouseId) throw badRequest('same_warehouse', 'Pick two different warehouses');
    await this.owned(org, dto.fromWarehouseId);
    await this.owned(org, dto.toWarehouseId);

    const transfer = await this.prisma.transfer.create({
      data: { ...dto, organizationId: org.organization.id, status: 'created', createdByUserId: userId },
    });
    const leg = (type: 'transfer_out' | 'transfer_in', warehouseId: string, quantity: string) =>
      this.inventory.postMovement({
        idempotencyKey: `transfer:${transfer.id}:${type}`,
        organizationId: org.organization.id,
        warehouseId,
        itemId: dto.itemId,
        type,
        quantity,
        sourceType: 'transfer',
        sourceId: transfer.id,
      });

    try {
      await leg('transfer_out', dto.fromWarehouseId, `-${dto.quantity}`);
    } catch (error) {
      await this.prisma.transfer.update({ where: { id: transfer.id }, data: { status: 'failed' } });
      const body = (error as { body?: { error?: { code?: string; message?: string } } }).body;
      throw new AppError(HttpStatus.CONFLICT, body?.error?.code ?? 'transfer_failed', body?.error?.message ?? 'The transfer could not be posted');
    }
    await this.prisma.transfer.update({ where: { id: transfer.id }, data: { status: 'out_posted' } });
    await leg('transfer_in', dto.toWarehouseId, dto.quantity);
    return this.prisma.transfer.update({ where: { id: transfer.id }, data: { status: 'completed' } });
  }

  private async owned(org: ActingOrganization, warehouseId: string) {
    const warehouse = await this.prisma.warehouse.findFirst({ where: { id: warehouseId, organizationId: org.organization.id } });
    if (!warehouse) throw notFound('Warehouse');
    return warehouse;
  }

  private announce(tx: Tx, receipt: Prisma.ReceiptGetPayload<{ include: typeof receiptInclude }>) {
    return emitEvent(tx, SERVICE_NAME, 'GoodsReceived', receipt.id, {
      receiptId: receipt.id,
      organizationId: receipt.organizationId,
      warehouseId: receipt.warehouseId,
      orderId: receipt.orderId,
      shipmentId: receipt.shipmentId,
      inspectionRequired: receipt.inspectionRequired,
      lines: receipt.lines.map((l) => ({
        itemId: l.itemId,
        orderLineId: l.orderLineId,
        receivedQuantity: l.receivedQuantity.toString(),
        rejectedQuantity: l.rejectedQuantity.toString(),
      })),
    });
  }
}
