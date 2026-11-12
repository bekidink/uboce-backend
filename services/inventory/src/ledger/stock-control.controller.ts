import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import {
  type ActingOrganization,
  ActingOrg,
  ActsForOrganization,
  type AuthUser,
  CurrentUser,
  IsDecimalString,
  PaginationQueryDto,
  RequiresModule,
} from '@uboce/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsIn, IsOptional, IsString, IsUUID, Length, ValidateNested } from 'class-validator';

import { StockControlService } from './stock-control.service.js';
import { WarehouseScope } from './scope.js';

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
    private readonly scope: WarehouseScope,
  ) {}

  private async ownWarehouse(org: ActingOrganization, warehouseId: string) {
    await this.scope.require(org, warehouseId, 'manage stock here');
  }

  /** A cycle count, checked against the member's locations. */
  private async ownCount(org: ActingOrganization, id: string) {
    const count = await this.stock.getCount(org, id);
    await this.ownWarehouse(org, count.warehouseId);
    return count;
  }

  /** Mark stock damaged or quarantined (or release it back to available). */
  @Post('state-changes')
  async changeState(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Body() dto: StateChangeDto) {
    await this.ownWarehouse(org, dto.warehouseId);
    return this.stock.changeState(org, user.userId, dto);
  }

  @Get('state-changes')
  async stateChanges(@ActingOrg() org: ActingOrganization, @Query() q: FilterDto) {
    return this.stock.stateChanges(org, { itemId: q.itemId, warehouseId: await this.scope.filter(org, q.warehouseId) }, q);
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
  async counts(@ActingOrg() org: ActingOrganization, @Query() q: PaginationQueryDto) {
    return this.stock.listCounts(org, q, await this.scope.filter(org));
  }

  @Get('cycle-counts/:id')
  count(@ActingOrg() org: ActingOrganization, @Id() id: string) {
    return this.ownCount(org, id);
  }

  @Post('cycle-counts/:id/lines')
  @HttpCode(200)
  async record(@ActingOrg() org: ActingOrganization, @Id() id: string, @Body() dto: CountLinesDto) {
    await this.ownCount(org, id);
    return this.stock.record(org, id, dto.lines);
  }

  @Post('cycle-counts/:id/submit')
  @HttpCode(200)
  async submit(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Id() id: string) {
    await this.ownCount(org, id);
    return this.stock.submit(org, user.userId, id);
  }

  /** Posts the variances; a different person than the counter must approve. */
  @Post('cycle-counts/:id/approve')
  @HttpCode(200)
  async approve(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Id() id: string) {
    await this.ownCount(org, id);
    return this.stock.approve(org, user.userId, id);
  }

  @Post('cycle-counts/:id/cancel')
  @HttpCode(200)
  async cancel(@ActingOrg() org: ActingOrganization, @Id() id: string) {
    await this.ownCount(org, id);
    return this.stock.cancel(org, id);
  }
}
