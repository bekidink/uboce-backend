import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import {
  type ActingOrganization,
  ActingOrg,
  ActsForOrganization,
  type AuthUser,
  badRequest,
  CurrentUser,
  IsDecimalString,
  PaginationQueryDto,
  WarehousesClient,
  RequiresModule,
} from '@uboce/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsIn, IsOptional, IsString, IsUUID, Length, ValidateNested } from 'class-validator';

import { StockControlService } from './stock-control.service.js';

const STATES = ['available', 'damaged', 'quarantined'] as const;

class StateChangeDto {
  @IsUUID()
  warehouseId: string;

  @IsUUID()
  itemId: string;

  @ApiProperty({ enum: STATES })
  @IsIn(STATES)
  from: (typeof STATES)[number];

  @ApiProperty({ enum: STATES })
  @IsIn(STATES)
  to: (typeof STATES)[number];

  @IsDecimalString('5')
  quantity: string;

  @IsString()
  @Length(3, 500)
  reason: string;
}

class WriteOffDto {
  @IsUUID()
  warehouseId: string;

  @IsUUID()
  itemId: string;

  @IsDecimalString('5')
  quantity: string;

  @IsString()
  @Length(3, 500)
  reason: string;
}

class StartCountDto {
  @IsUUID()
  warehouseId: string;

  /** Count only these items; leave out to count everything in the warehouse. */
  @IsOptional()
  @IsUUID('all', { each: true })
  @ArrayMaxSize(500)
  itemIds?: string[];

  @IsOptional()
  @IsString()
  @Length(0, 500)
  note?: string;
}

class CountLineDto {
  @IsUUID()
  itemId: string;

  @IsDecimalString('48')
  countedQuantity: string;

  @IsOptional()
  @IsString()
  @Length(0, 300)
  note?: string;
}

class CountLinesDto {
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => CountLineDto)
  lines: CountLineDto[];
}

class FilterDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  itemId?: string;

  @IsOptional()
  @IsUUID()
  warehouseId?: string;
}

const Id = () => Param('id', new ParseUUIDPipe());

@ApiTags('inventory')
@ApiBearerAuth()
@ActsForOrganization()
@RequiresModule('inventory')
@Controller('inventory')
export class StockControlController {
  constructor(
    private readonly stock: StockControlService,
    private readonly warehouses: WarehousesClient,
  ) {}

  private async ownWarehouse(org: ActingOrganization, warehouseId: string) {
    const warehouse = await this.warehouses.get(warehouseId);
    if (!warehouse || warehouse.organizationId !== org.organization.id) throw badRequest('unknown_warehouse', 'Warehouse not found in your organization');
  }

  /** Mark stock damaged or quarantined (or release it back to available). */
  @Post('state-changes')
  async changeState(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Body() dto: StateChangeDto) {
    await this.ownWarehouse(org, dto.warehouseId);
    return this.stock.changeState(org, user.userId, dto);
  }

  @Get('state-changes')
  stateChanges(@ActingOrg() org: ActingOrganization, @Query() q: FilterDto) {
    return this.stock.stateChanges(org, { itemId: q.itemId, warehouseId: q.warehouseId }, q);
  }

  /** Remove damaged stock from the books. */
  @Post('write-offs')
  async writeOff(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Body() dto: WriteOffDto) {
    await this.ownWarehouse(org, dto.warehouseId);
    return this.stock.writeOff(org, user.userId, dto);
  }

  @Post('cycle-counts')
  async startCount(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Body() dto: StartCountDto) {
    await this.ownWarehouse(org, dto.warehouseId);
    return this.stock.startCount(org, user.userId, dto);
  }

  @Get('cycle-counts')
  counts(@ActingOrg() org: ActingOrganization, @Query() q: PaginationQueryDto) {
    return this.stock.listCounts(org, q);
  }

  @Get('cycle-counts/:id')
  count(@ActingOrg() org: ActingOrganization, @Id() id: string) {
    return this.stock.getCount(org, id);
  }

  @Post('cycle-counts/:id/lines')
  @HttpCode(200)
  record(@ActingOrg() org: ActingOrganization, @Id() id: string, @Body() dto: CountLinesDto) {
    return this.stock.record(org, id, dto.lines);
  }

  @Post('cycle-counts/:id/submit')
  @HttpCode(200)
  submit(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Id() id: string) {
    return this.stock.submit(org, user.userId, id);
  }

  /** Posts the variances; a different person than the counter must approve. */
  @Post('cycle-counts/:id/approve')
  @HttpCode(200)
  approve(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Id() id: string) {
    return this.stock.approve(org, user.userId, id);
  }

  @Post('cycle-counts/:id/cancel')
  @HttpCode(200)
  cancel(@ActingOrg() org: ActingOrganization, @Id() id: string) {
    return this.stock.cancel(org, id);
  }
}
