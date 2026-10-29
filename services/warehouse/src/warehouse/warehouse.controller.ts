import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController, ApiTags } from '@nestjs/swagger';
import {
  type ActingOrganization,
  ActingOrg,
  ActsForOrganization,
  type AuthUser,
  CurrentUser,
  Internal,
  IsDecimalString,
  PaginationQueryDto,
  RequiresModule,
} from '@uboce/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsBoolean, IsOptional, IsString, IsUUID, Length, Matches, ValidateNested } from 'class-validator';

import { WarehouseService } from './warehouse.service.js';

class CreateWarehouseDto {
  @Matches(/^[A-Z0-9-]{2,20}$/, { message: 'code: 2–20 uppercase letters, digits or dashes' })
  code: string;

  @IsString()
  @Length(2, 150)
  name: string;

  @IsOptional()
  @Matches(/^[A-Z]{2}$/)
  countryCode?: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  region?: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  city?: string;

  @IsOptional()
  @IsString()
  @Length(1, 300)
  addressLine?: string;

  /** Organization location (branch) the warehouse belongs to. */
  @IsOptional()
  @IsUUID()
  branchId?: string;
}

class LocationDto {
  @Matches(/^[A-Z0-9-]{1,30}$/)
  code: string;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  description?: string;
}

class ReceiptLineDto {
  @IsUUID()
  itemId: string;

  @IsOptional()
  @IsUUID()
  orderLineId?: string;

  @IsString()
  @Length(1, 300)
  description: string;

  @IsOptional()
  @IsDecimalString('50')
  expectedQuantity?: string;

  @IsDecimalString('48')
  receivedQuantity: string;

  @IsOptional()
  @IsDecimalString('2')
  rejectedQuantity?: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  discrepancyNote?: string;
}

class ReceiptDto {
  @IsUUID()
  warehouseId: string;

  @IsOptional()
  @IsUUID()
  orderId?: string;

  @IsOptional()
  @IsUUID()
  shipmentId?: string;

  /** Hold stock until Quality decides what is accepted. */
  @IsBoolean()
  inspectionRequired: boolean;

  @IsOptional()
  @IsString()
  @Length(0, 1000)
  notes?: string;

  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ReceiptLineDto)
  lines: ReceiptLineDto[];
}

class TransferDto {
  @IsUUID()
  fromWarehouseId: string;

  @IsUUID()
  toWarehouseId: string;

  @IsUUID()
  itemId: string;

  @IsDecimalString('10')
  quantity: string;
}

@ApiTags('warehouse')
@ApiBearerAuth()
@ActsForOrganization()
@RequiresModule('warehouse')
@Controller('warehouse')
export class WarehouseController {
  constructor(private readonly warehouse: WarehouseService) {}

  @Post('warehouses')
  create(@ActingOrg() org: ActingOrganization, @Body() dto: CreateWarehouseDto) {
    return this.warehouse.createWarehouse(org, dto);
  }

  @Get('warehouses')
  list(@ActingOrg() org: ActingOrganization, @Query() query: PaginationQueryDto) {
    return this.warehouse.listWarehouses(org, query);
  }

  @Post('warehouses/:warehouseId/locations')
  addLocation(@ActingOrg() org: ActingOrganization, @Param('warehouseId', new ParseUUIDPipe()) id: string, @Body() dto: LocationDto) {
    return this.warehouse.addLocation(org, id, dto);
  }

  @Post('receipts')
  receive(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Body() dto: ReceiptDto) {
    return this.warehouse.receive(org, user.userId, dto);
  }

  @Get('receipts')
  receipts(@ActingOrg() org: ActingOrganization, @Query() query: PaginationQueryDto) {
    return this.warehouse.listReceipts(org, query);
  }

  @Get('receipts/:receiptId')
  receipt(@ActingOrg() org: ActingOrganization, @Param('receiptId', new ParseUUIDPipe()) id: string) {
    return this.warehouse.getReceipt(org, id);
  }

  @Post('transfers')
  transfer(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Body() dto: TransferDto) {
    return this.warehouse.transfer(org, user.userId, dto);
  }
}

@ApiExcludeController()
@Controller('internal/warehouses')
export class InternalWarehouseController {
  constructor(private readonly warehouse: WarehouseService) {}

  @Internal()
  @Get(':warehouseId')
  get(@Param('warehouseId', new ParseUUIDPipe()) id: string) {
    return this.warehouse.internalGet(id);
  }
}
