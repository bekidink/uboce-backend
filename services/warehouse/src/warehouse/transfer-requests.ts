import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Injectable,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  type ActingOrganization,
  ActingOrg,
  ActsForOrganization,
  AppError,
  type AuthUser,
  badRequest,
  conflict,
  CurrentUser,
  forbidden,
  InventoryClient,
  IsDecimalString,
  locationScope,
  notFound,
  PaginationQueryDto,
  RequiresModule,
  requireRole,
  skipTake,
  toPage,
} from '@uboce/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  ValidateNested,
} from 'class-validator';

import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma.service.js';
import { WAREHOUSE_ROLES } from './warehouse.service.js';

const { Decimal } = Prisma;
const READ_ROLES = [
  ...WAREHOUSE_ROLES,
  'logistics_operator',
  'procurement_officer',
  'sales_representative',
  'manufacturer',
  'farmer',
  'auditor',
];
const STATUSES = ['requested', 'approved', 'in_transit', 'received', 'rejected', 'cancelled'] as const;

class RequestLineDto {
  @IsUUID()
  itemId: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  description?: string;

  @IsDecimalString('10')
  quantity: string;
}

class CreateTransferRequestDto {
  /** The warehouse that has the stock (another branch). */
  @IsUUID()
  fromWarehouseId: string;

  /** Your warehouse that needs it. */
  @IsUUID()
  toWarehouseId: string;

  @ValidateNested({ each: true })
  @Type(() => RequestLineDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  lines: RequestLineDto[];

  @IsOptional()
  @IsString()
  @Length(0, 1000)
  note?: string;

  @IsOptional()
  @IsDateString()
  neededBy?: string;
}

class ApproveLineDto {
  @IsUUID()
  lineId: string;

  @IsDecimalString('0')
  quantity: string;
}

class RespondDto {
  @IsIn(['approve', 'reject'])
  decision: 'approve' | 'reject';

  @IsOptional()
  @IsString()
  @Length(0, 1000)
  note?: string;

  /** Approve less than asked on some lines (others get the full request). */
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => ApproveLineDto)
  @ArrayMaxSize(50)
  lines?: ApproveLineDto[];
}

class ReceiveDto {
  /** Leave out to receive everything that was sent. */
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => ApproveLineDto)
  @ArrayMaxSize(50)
  lines?: ApproveLineDto[];

  @IsOptional()
  @IsString()
  @Length(0, 1000)
  note?: string;
}

class ListTransferRequestsDto extends PaginationQueryDto {
  /** incoming: other branches asking you; outgoing: what you asked for. */
  @IsOptional()
  @IsIn(['incoming', 'outgoing', 'all'])
  direction?: 'incoming' | 'outgoing' | 'all';

  @IsOptional()
  @IsIn(STATUSES)
  status?: (typeof STATUSES)[number];

  @IsOptional()
  @IsUUID()
  branchId?: string;
}

const include = { lines: { orderBy: { description: 'asc' } } } as const;

/** Branch-to-branch stock: see what other branches hold and ask them for it. */
@Injectable()
export class TransferRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryClient,
  ) {}

  /** Every warehouse in the organization, marking the ones the user works at. */
  async network(org: ActingOrganization) {
    requireRole(org, READ_ROLES, 'view other branches');
    const scope = locationScope(org);
    const warehouses = await this.prisma.warehouse.findMany({
      where: { organizationId: org.organization.id, status: 'active' },
      orderBy: { name: 'asc' },
    });
    return warehouses.map((w) => ({
      id: w.id,
      code: w.code,
      name: w.name,
      city: w.city,
      region: w.region,
      branchId: w.branchId,
      mine: !scope || (w.branchId !== null && scope.includes(w.branchId)),
    }));
  }

  async create(org: ActingOrganization, userId: string, dto: CreateTransferRequestDto) {
    requireRole(org, WAREHOUSE_ROLES, 'request stock from another branch');
    if (dto.fromWarehouseId === dto.toWarehouseId)
      throw badRequest('same_warehouse', 'Pick two different warehouses');
    const [from, to] = await Promise.all([
      this.warehouse(org, dto.fromWarehouseId, false),
      this.warehouse(org, dto.toWarehouseId, true),
    ]);
    const items = new Set<string>();
    for (const l of dto.lines) {
      if (items.has(l.itemId)) throw badRequest('duplicate_item', 'Each item can appear once');
      items.add(l.itemId);
      if (new Decimal(l.quantity).lte(0))
        throw badRequest('invalid_quantity', 'Quantities must be above zero');
    }
    for (let attempt = 0; ; attempt++) {
      const count = await this.prisma.transferRequest.count({
        where: { organizationId: org.organization.id },
      });
      const number = `TR-${new Date().getFullYear()}-${String(count + 1 + attempt).padStart(5, '0')}`;
      try {
        return await this.prisma.transferRequest.create({
          data: {
            organizationId: org.organization.id,
            number,
            fromWarehouseId: from.id,
            toWarehouseId: to.id,
            fromBranchId: from.branchId,
            toBranchId: to.branchId,
            note: dto.note?.trim() || null,
            neededBy: dto.neededBy ? new Date(dto.neededBy) : null,
            requestedByUserId: userId,
            lines: {
              create: dto.lines.map((l) => ({
                itemId: l.itemId,
                description: l.description?.trim() || 'Item',
                requestedQuantity: l.quantity,
              })),
            },
          },
          include,
        });
      } catch (error) {
        if (attempt < 3 && error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
          continue;
        throw error;
      }
    }
  }

  async list(org: ActingOrganization, q: ListTransferRequestsDto) {
    requireRole(org, READ_ROLES, 'view transfer requests');
    const scope = locationScope(org);
    const mine = scope
      ? (
          await this.prisma.warehouse.findMany({
            where: { organizationId: org.organization.id, branchId: { in: scope } },
            select: { id: true },
          })
        ).map((w) => w.id)
      : null;
    const direction = q.direction ?? 'all';
    const side = (field: 'fromWarehouseId' | 'toWarehouseId') => (mine ? { [field]: { in: mine } } : {});
    const where: Prisma.TransferRequestWhereInput = {
      organizationId: org.organization.id,
      ...(q.status ? { status: q.status } : {}),
      ...(q.branchId ? { OR: [{ fromBranchId: q.branchId }, { toBranchId: q.branchId }] } : {}),
      ...(direction === 'incoming'
        ? side('fromWarehouseId')
        : direction === 'outgoing'
          ? side('toWarehouseId')
          : mine
            ? { AND: [{ OR: [{ fromWarehouseId: { in: mine } }, { toWarehouseId: { in: mine } }] }] }
            : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.transferRequest.findMany({
        where,
        include,
        orderBy: { createdAt: 'desc' },
        ...skipTake(q),
      }),
      this.prisma.transferRequest.count({ where }),
    ]);
    return toPage(items, total, q);
  }

  async get(org: ActingOrganization, id: string) {
    requireRole(org, READ_ROLES, 'view transfer requests');
    const request = await this.prisma.transferRequest.findFirst({
      where: { id, organizationId: org.organization.id },
      include,
    });
    if (!request) throw notFound('Transfer request');
    const scope = locationScope(org);
    if (scope && ![request.fromBranchId, request.toBranchId].some((b) => b && scope.includes(b)))
      throw notFound('Transfer request');
    return request;
  }

  /** The source branch approves (possibly less) or rejects. */
  async respond(org: ActingOrganization, userId: string, id: string, dto: RespondDto) {
    requireRole(org, WAREHOUSE_ROLES, 'answer transfer requests');
    const request = await this.get(org, id);
    await this.warehouse(org, request.fromWarehouseId, true);
    if (request.status !== 'requested')
      throw conflict('not_requested', `This request is already ${request.status.replace('_', ' ')}`);
    const now = new Date();
    if (dto.decision === 'reject') {
      return this.prisma.transferRequest.update({
        where: { id },
        data: {
          status: 'rejected',
          responseNote: dto.note?.trim() || null,
          respondedByUserId: userId,
          respondedAt: now,
        },
        include,
      });
    }
    const overrides = new Map((dto.lines ?? []).map((l) => [l.lineId, new Decimal(l.quantity)]));
    for (const lineId of overrides.keys())
      if (!request.lines.some((l) => l.id === lineId))
        throw badRequest('unknown_line', 'A line does not belong to this request');
    return this.prisma.$transaction(async (tx) => {
      for (const line of request.lines) {
        const qty = overrides.get(line.id) ?? line.requestedQuantity;
        if (qty.lt(0) || qty.gt(line.requestedQuantity))
          throw badRequest('invalid_quantity', 'Approve between zero and the requested quantity');
        await tx.transferRequestLine.update({ where: { id: line.id }, data: { approvedQuantity: qty } });
      }
      return tx.transferRequest.update({
        where: { id },
        data: {
          status: 'approved',
          responseNote: dto.note?.trim() || null,
          respondedByUserId: userId,
          respondedAt: now,
        },
        include,
      });
    });
  }

  /** Source sends the stock: it leaves the source warehouse now. Retrying is safe. */
  async dispatch(org: ActingOrganization, userId: string, id: string) {
    requireRole(org, WAREHOUSE_ROLES, 'dispatch transfers');
    const request = await this.get(org, id);
    await this.warehouse(org, request.fromWarehouseId, true);
    if (request.status !== 'approved')
      throw conflict('not_approved', 'Only approved requests can be dispatched');
    for (const line of request.lines) {
      if (!line.approvedQuantity || line.approvedQuantity.lte(0)) continue;
      try {
        await this.inventory.postMovement({
          idempotencyKey: `transfer-request:${id}:${line.id}:out`,
          organizationId: request.organizationId,
          warehouseId: request.fromWarehouseId,
          itemId: line.itemId,
          type: 'transfer_out',
          quantity: `-${line.approvedQuantity.toString()}`,
          sourceType: 'transfer_request',
          sourceId: id,
        });
      } catch (error) {
        const body = (error as { body?: { error?: { code?: string; message?: string } } }).body;
        throw new AppError(
          HttpStatus.CONFLICT,
          body?.error?.code ?? 'dispatch_failed',
          `${line.description}: ${body?.error?.message ?? 'could not be taken out of stock'}`,
        );
      }
    }
    return this.prisma.transferRequest.update({
      where: { id },
      data: { status: 'in_transit', dispatchedByUserId: userId, dispatchedAt: new Date() },
      include,
    });
  }

  /** Destination confirms what arrived; that quantity is added to its stock. */
  async receive(org: ActingOrganization, userId: string, id: string, dto: ReceiveDto) {
    requireRole(org, WAREHOUSE_ROLES, 'receive transfers');
    const request = await this.get(org, id);
    await this.warehouse(org, request.toWarehouseId, true);
    if (request.status !== 'in_transit')
      throw conflict('not_in_transit', 'Only dispatched transfers can be received');
    const counted = new Map((dto.lines ?? []).map((l) => [l.lineId, new Decimal(l.quantity)]));
    for (const line of request.lines) {
      const sent = line.approvedQuantity ?? new Decimal(0);
      const got = counted.get(line.id) ?? sent;
      if (got.lt(0) || got.gt(sent))
        throw badRequest(
          'invalid_quantity',
          `${line.description}: receive between zero and ${sent.toString()}`,
        );
      if (got.gt(0)) {
        await this.inventory.postMovement({
          idempotencyKey: `transfer-request:${id}:${line.id}:in`,
          organizationId: request.organizationId,
          warehouseId: request.toWarehouseId,
          itemId: line.itemId,
          type: 'transfer_in',
          quantity: got.toString(),
          sourceType: 'transfer_request',
          sourceId: id,
        });
      }
      await this.prisma.transferRequestLine.update({
        where: { id: line.id },
        data: { receivedQuantity: got },
      });
    }
    return this.prisma.transferRequest.update({
      where: { id },
      data: {
        status: 'received',
        receivedByUserId: userId,
        receivedAt: new Date(),
        ...(dto.note?.trim()
          ? {
              responseNote: [request.responseNote, `Received: ${dto.note.trim()}`].filter(Boolean).join('\n'),
            }
          : {}),
      },
      include,
    });
  }

  /** The requesting branch withdraws before anything is sent. */
  async cancel(org: ActingOrganization, id: string) {
    requireRole(org, WAREHOUSE_ROLES, 'cancel transfer requests');
    const request = await this.get(org, id);
    await this.warehouse(org, request.toWarehouseId, true);
    if (!['requested', 'approved'].includes(request.status))
      throw conflict('cannot_cancel', 'Sent transfers cannot be cancelled');
    return this.prisma.transferRequest.update({ where: { id }, data: { status: 'cancelled' }, include });
  }

  /** A warehouse of the organization; `mine` also requires the user to work at its location. */
  private async warehouse(org: ActingOrganization, id: string, mine: boolean) {
    const w = await this.prisma.warehouse.findFirst({ where: { id, organizationId: org.organization.id } });
    if (!w) throw notFound('Warehouse');
    const scope = locationScope(org);
    if (mine && scope && !(w.branchId && scope.includes(w.branchId)))
      throw forbidden('You can only act for warehouses at your own locations');
    return w;
  }
}

const Id = () => Param('requestId', new ParseUUIDPipe());

@ApiTags('warehouse')
@ApiBearerAuth()
@ActsForOrganization()
@RequiresModule('warehouse')
@Controller('warehouse')
export class TransferRequestsController {
  constructor(private readonly transfers: TransferRequestsService) {}

  /** All of the organization's warehouses (for viewing other branches' stock). */
  @Get('network')
  network(@ActingOrg() org: ActingOrganization) {
    return this.transfers.network(org);
  }

  @Get('transfer-requests')
  list(@ActingOrg() org: ActingOrganization, @Query() q: ListTransferRequestsDto) {
    return this.transfers.list(org, q);
  }

  @Post('transfer-requests')
  create(
    @ActingOrg() org: ActingOrganization,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateTransferRequestDto,
  ) {
    return this.transfers.create(org, user.userId, dto);
  }

  @Get('transfer-requests/:requestId')
  get(@ActingOrg() org: ActingOrganization, @Id() id: string) {
    return this.transfers.get(org, id);
  }

  @Post('transfer-requests/:requestId/respond')
  @HttpCode(200)
  respond(
    @ActingOrg() org: ActingOrganization,
    @CurrentUser() user: AuthUser,
    @Id() id: string,
    @Body() dto: RespondDto,
  ) {
    return this.transfers.respond(org, user.userId, id, dto);
  }

  @Post('transfer-requests/:requestId/dispatch')
  @HttpCode(200)
  dispatch(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Id() id: string) {
    return this.transfers.dispatch(org, user.userId, id);
  }

  @Post('transfer-requests/:requestId/receive')
  @HttpCode(200)
  receive(
    @ActingOrg() org: ActingOrganization,
    @CurrentUser() user: AuthUser,
    @Id() id: string,
    @Body() dto: ReceiveDto,
  ) {
    return this.transfers.receive(org, user.userId, id, dto);
  }

  @Post('transfer-requests/:requestId/cancel')
  @HttpCode(200)
  cancel(@ActingOrg() org: ActingOrganization, @Id() id: string) {
    return this.transfers.cancel(org, id);
  }
}
