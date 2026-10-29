import {
  type BeforeApplicationShutdown,
  Body,
  Controller,
  Get,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { type ActingOrganization, ActingOrg, ActsForOrganization, type AuthUser, CurrentUser, IsDecimalString, PaginationQueryDto, RequiresModule } from '@uboce/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsOptional, IsString, IsUUID, Length, Matches, ValidateNested } from 'class-validator';

import { ProductionService } from './production.service.js';

class ComponentDto {
  @IsUUID()
  itemId: string;

  @IsString()
  @Length(1, 200)
  description: string;

  @IsDecimalString('120')
  quantity: string;

  @Matches(/^[a-z_]{1,20}$/)
  unitOfMeasure: string;
}

class BomDto {
  @IsString()
  @Length(2, 150)
  name: string;

  @IsUUID()
  outputItemId: string;

  @IsDecimalString('100')
  outputQuantity: string;

  @Matches(/^[a-z_]{1,20}$/)
  unitOfMeasure: string;

  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ComponentDto)
  components: ComponentDto[];
}

class ProductionOrderDto {
  @IsUUID()
  bomId: string;

  @IsDecimalString('250')
  plannedOutput: string;

  /** Materials are taken from, and output goes to, this warehouse. */
  @IsUUID()
  warehouseId: string;
}

class ConsumptionDto {
  @IsUUID()
  itemId: string;

  @IsDecimalString('300')
  quantity: string;
}

class CompleteDto {
  @IsDecimalString('240')
  outputQuantity: string;

  @IsOptional()
  @IsDecimalString('6')
  wasteQuantity?: string;

  @IsOptional()
  @IsString()
  @Length(0, 1000)
  notes?: string;

  /** Actual materials used; defaults to the recipe scaled to plan. */
  @IsOptional()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ConsumptionDto)
  consumptions?: ConsumptionDto[];
}

const Id = (name: string) => Param(name, new ParseUUIDPipe());

@ApiTags('manufacturing')
@ApiBearerAuth()
@ActsForOrganization()
@RequiresModule('manufacturing')
@Controller('manufacturing')
export class ProductionController {
  constructor(private readonly production: ProductionService) {}

  @Post('boms')
  createBom(@ActingOrg() org: ActingOrganization, @Body() dto: BomDto) {
    return this.production.createBom(org, dto);
  }

  @Get('boms')
  boms(@ActingOrg() org: ActingOrganization, @Query() query: PaginationQueryDto) {
    return this.production.listBoms(org, query);
  }

  @Post('production-orders')
  createOrder(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Body() dto: ProductionOrderDto) {
    return this.production.createOrder(org, user.userId, dto);
  }

  @Get('production-orders')
  orders(@ActingOrg() org: ActingOrganization, @Query() query: PaginationQueryDto) {
    return this.production.listOrders(org, query);
  }

  @Get('production-orders/:orderId')
  order(@ActingOrg() org: ActingOrganization, @Id('orderId') id: string) {
    return this.production.getOrder(org, id);
  }

  /** Reserves the materials. Fails with the shortages if stock is insufficient. */
  @Post('production-orders/:orderId/release')
  release(@ActingOrg() org: ActingOrganization, @Id('orderId') id: string) {
    return this.production.release(org, id);
  }

  @Post('production-orders/:orderId/complete')
  complete(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Id('orderId') id: string, @Body() dto: CompleteDto) {
    return this.production.complete(org, user.userId, id, dto);
  }

  @Post('production-orders/:orderId/cancel')
  cancel(@ActingOrg() org: ActingOrganization, @Id('orderId') id: string) {
    return this.production.cancel(org, id);
  }

  @Get('batches/:batchId/trace')
  trace(@ActingOrg() org: ActingOrganization, @Id('batchId') id: string) {
    return this.production.traceBatch(org, id);
  }
}

/** Retries stock postings Inventory didn't accept yet. */
@Injectable()
export class ProductionPostingRetryJob implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(ProductionPostingRetryJob.name);
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;

  constructor(private readonly production: ProductionService) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => {
      this.running ??= this.production
        .flush()
        .catch((error) => this.logger.error(`Production posting retry failed: ${error}`))
        .finally(() => (this.running = null));
    }, 30_000);
  }

  async beforeApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
