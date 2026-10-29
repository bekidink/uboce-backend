import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController, ApiHeader, ApiTags } from '@nestjs/swagger';
import {
  type ActingOrganization,
  ActingOrg,
  ActsForOrganization,
  type AuthUser,
  badRequest,
  CallingService,
  CurrentUser,
  Internal,
  IsDecimalString,
  PaginationQueryDto,
  requireRole,
  type ServiceCaller,
  WarehousesClient,
  RequiresModule,
} from '@uboce/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  ValidateNested,
} from 'class-validator';
import type { Response } from 'express';

import { LedgerService } from './ledger.service.js';

const STOCK_ROLES = ['owner', 'admin', 'warehouse_operator'];
const READ_ROLES = [...STOCK_ROLES, 'sales_representative', 'procurement_officer', 'manufacturer', 'farmer', 'logistics_operator', 'finance_officer', 'auditor', 'quality_inspector'];
const SIGNED_DECIMAL = /^-?\d{1,14}(\.\d{1,4})?$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_:.-]{8,150}$/;

class FilterQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  itemId?: string;

  @IsOptional()
  @IsUUID()
  warehouseId?: string;
}

class AdjustmentDto {
  @IsUUID()
  warehouseId: string;

  @IsUUID()
  itemId: string;

  /** Signed: +5 found in a count, -2 damaged. */
  @Matches(SIGNED_DECIMAL)
  quantity: string;

  @Matches(/^[a-z][a-z0-9_]{2,40}$/)
  reasonCode: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  note?: string;
}

class ReverseDto {
  @IsString()
  @Length(5, 500)
  reason: string;
}

class InternalMovementDto {
  @Matches(IDEMPOTENCY_KEY)
  idempotencyKey: string;

  @IsUUID()
  organizationId: string;

  @IsUUID()
  warehouseId: string;

  @IsUUID()
  itemId: string;

  @IsIn(['receipt', 'issue', 'adjustment', 'production_issue', 'production_output', 'transfer_in', 'transfer_out'])
  type: 'receipt' | 'issue' | 'adjustment' | 'production_issue' | 'production_output' | 'transfer_in' | 'transfer_out';

  @Matches(SIGNED_DECIMAL)
  quantity: string;

  @IsOptional()
  @Matches(/^[a-z_]{1,20}$/)
  unitOfMeasure?: string;

  @Matches(/^[a-z_]{2,40}$/)
  sourceType: string;

  @IsString()
  @Length(1, 100)
  sourceId: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  note?: string;

  @IsOptional()
  reservation?: { referenceType: 'order' | 'production_order'; referenceId: string };
}

class ReserveLineDto {
  @IsUUID()
  itemId: string;

  @IsDecimalString('10')
  quantity: string;

  @IsOptional()
  @IsUUID()
  warehouseId?: string;
}

class InternalReserveDto {
  @IsUUID()
  organizationId: string;

  @IsIn(['order', 'production_order'])
  referenceType: 'order' | 'production_order';

  @IsUUID()
  referenceId: string;

  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ReserveLineDto)
  lines: ReserveLineDto[];
}

@ApiTags('inventory')
@ApiBearerAuth()
@ActsForOrganization()
@RequiresModule('inventory')
@Controller('inventory')
export class InventoryController {
  constructor(
    private readonly ledger: LedgerService,
    private readonly warehouses: WarehousesClient,
  ) {}

  /** On hand, reserved and available, per item and warehouse. */
  @Get('balances')
  balances(@ActingOrg() org: ActingOrganization, @Query() q: FilterQueryDto) {
    requireRole(org, READ_ROLES, 'view stock');
    return this.ledger.balances(org.organization.id, { itemId: q.itemId, warehouseId: q.warehouseId }, q);
  }

  /** The full ledger, newest first. */
  @Get('movements')
  movements(@ActingOrg() org: ActingOrganization, @Query() q: FilterQueryDto) {
    requireRole(org, READ_ROLES, 'view stock');
    return this.ledger.movements(org.organization.id, { itemId: q.itemId, warehouseId: q.warehouseId }, q);
  }

  @Get('reservations/:referenceType/:referenceId')
  reservation(
    @ActingOrg() org: ActingOrganization,
    @Param('referenceType') referenceType: string,
    @Param('referenceId', new ParseUUIDPipe()) referenceId: string,
  ) {
    requireRole(org, READ_ROLES, 'view stock');
    return this.ledger.reservation(org.organization.id, referenceType, referenceId);
  }

  /** Stock-count corrections, damage, loss. Needs an Idempotency-Key. */
  @ApiHeader({ name: 'idempotency-key', required: true })
  @Post('adjustments')
  async adjust(
    @ActingOrg() org: ActingOrganization,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: AdjustmentDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    requireRole(org, STOCK_ROLES, 'adjust stock');
    if (!key || !IDEMPOTENCY_KEY.test(key)) throw badRequest('idempotency_key_required', 'Send an Idempotency-Key header');
    const warehouse = await this.warehouses.get(dto.warehouseId);
    if (!warehouse || warehouse.organizationId !== org.organization.id) throw badRequest('unknown_warehouse', 'Warehouse not found in your organization');
    const result = await this.ledger.post({
      idempotencyKey: `adjustment:${org.organization.id}:${key}`,
      organizationId: org.organization.id,
      warehouseId: dto.warehouseId,
      itemId: dto.itemId,
      type: 'adjustment',
      quantity: dto.quantity,
      sourceType: 'adjustment',
      sourceId: dto.reasonCode,
      note: dto.note,
      createdBy: `user:${user.userId}`,
    });
    res.status(result.replayed ? 200 : 201);
    return result;
  }

  @Post('movements/:movementId/reverse')
  reverse(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Param('movementId', new ParseUUIDPipe()) id: string, @Body() dto: ReverseDto) {
    requireRole(org, STOCK_ROLES, 'reverse movements');
    return this.ledger.reverse(org.organization.id, id, `user:${user.userId}`, dto.reason);
  }
}

/** Stock changes from other services always come through here (PRD 5.10: Warehouse never edits stock). */
@ApiExcludeController()
@Controller('internal')
export class InternalInventoryController {
  constructor(private readonly ledger: LedgerService) {}

  @Internal('warehouse', 'logistics', 'manufacturing', 'agriculture')
  @Post('movements')
  @HttpCode(200)
  movement(@CallingService() caller: ServiceCaller, @Body() dto: InternalMovementDto) {
    return this.ledger.post({ ...dto, createdBy: `service:${caller.service}` });
  }

  @Internal('manufacturing')
  @Post('reservations')
  @HttpCode(200)
  reserve(@Body() dto: InternalReserveDto) {
    return this.ledger.reserve(dto);
  }

  @Internal('manufacturing', 'commerce')
  @Post('reservations/:referenceType/:referenceId/release')
  @HttpCode(200)
  release(@Param('referenceType') referenceType: string, @Param('referenceId', new ParseUUIDPipe()) referenceId: string) {
    return this.ledger.release(referenceType, referenceId);
  }
}
