import { Body, Controller, Get, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { type ActingOrganization, ActingOrg, ActsForOrganization, type AuthUser, CurrentUser, IsDecimalString, PaginationQueryDto } from '@uboce/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import { CroppingSeason } from '../generated/prisma/enums.js';
import { AgricultureService } from './agriculture.service.js';

const COORD = /^-?\d{1,3}(\.\d{1,6})?$/;

class FarmDto {
  @IsString()
  @Length(2, 150)
  name: string;

  @IsOptional()
  @IsUUID()
  memberUserId?: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  region?: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  zone?: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  woreda?: string;

  @IsOptional()
  @Matches(COORD)
  latitude?: string;

  @IsOptional()
  @Matches(COORD)
  longitude?: string;

  @IsOptional()
  @IsDecimalString('2.5')
  areaHectares?: string;
}

class PlotDto {
  @IsString()
  @Length(1, 100)
  name: string;

  @IsOptional()
  @IsDecimalString('0.75')
  areaHectares?: string;
}

class SeasonDto {
  @IsUUID()
  farmId: string;

  @IsOptional()
  @IsUUID()
  plotId?: string;

  @IsString()
  @Length(2, 60)
  crop: string;

  @IsInt()
  @Min(2000)
  @Max(2100)
  year: number;

  @ApiProperty({ enum: CroppingSeason })
  @IsEnum(CroppingSeason)
  season: CroppingSeason;

  @IsOptional()
  @IsDateString()
  plantedAt?: string;

  @IsOptional()
  @IsDecimalString('40')
  expectedHarvestQuantity?: string;

  @Matches(/^[a-z_]{1,20}$/)
  unitOfMeasure: string;
}

class HarvestDto {
  @IsDateString()
  harvestedAt: string;

  @IsDecimalString('38')
  quantity: string;

  @IsOptional()
  @IsString()
  @Length(0, 1000)
  notes?: string;
}

class HarvestShareDto {
  @IsUUID()
  harvestId: string;

  @IsDecimalString('20')
  quantity: string;
}

class LotFromHarvestsDto {
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => HarvestShareDto)
  harvests: HarvestShareDto[];

  @IsOptional()
  @IsUUID()
  productId?: string;

  @IsOptional()
  @IsString()
  @Length(1, 40)
  grade?: string;

  /** Where the lot is stored; its stock is then tracked in Inventory. */
  @IsOptional()
  @IsUUID()
  warehouseId?: string;
}

class SplitDto {
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(50)
  @Matches(/^\d{1,14}(\.\d{1,4})?$/, { each: true })
  quantities: string[];
}

class MergeDto {
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  lotIds: string[];

  @IsOptional()
  @IsString()
  @Length(1, 40)
  grade?: string;
}

class GradeDto {
  @IsString()
  @Length(1, 40)
  grade: string;

  @IsOptional()
  @Matches(/^\d{1,2}(\.\d{1,2})?$/)
  moisturePct?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  defectCount?: number;

  @IsOptional()
  @IsString()
  @Length(0, 1000)
  notes?: string;
}

class SeasonsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  farmId?: string;
}

class LotsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(['active', 'depleted'])
  status?: 'active' | 'depleted';
}

const Id = (name: string) => Param(name, new ParseUUIDPipe());

@ApiTags('agriculture')
@ApiBearerAuth()
@ActsForOrganization()
@Controller('agriculture')
export class AgricultureController {
  constructor(private readonly agriculture: AgricultureService) {}

  @Post('farms')
  createFarm(@ActingOrg() org: ActingOrganization, @Body() dto: FarmDto) {
    return this.agriculture.createFarm(org, dto);
  }

  @Get('farms')
  farms(@ActingOrg() org: ActingOrganization, @Query() query: PaginationQueryDto) {
    return this.agriculture.listFarms(org, query);
  }

  @Post('farms/:farmId/plots')
  addPlot(@ActingOrg() org: ActingOrganization, @Id('farmId') farmId: string, @Body() dto: PlotDto) {
    return this.agriculture.addPlot(org, farmId, dto);
  }

  @Post('seasons')
  season(@ActingOrg() org: ActingOrganization, @Body() dto: SeasonDto) {
    return this.agriculture.createSeason(org, dto);
  }

  @Get('seasons')
  seasons(@ActingOrg() org: ActingOrganization, @Query() query: SeasonsQueryDto) {
    return this.agriculture.listSeasons(org, query.farmId, query);
  }

  @Post('seasons/:seasonId/harvests')
  harvest(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Id('seasonId') seasonId: string, @Body() dto: HarvestDto) {
    return this.agriculture.recordHarvest(org, user.userId, seasonId, dto);
  }

  @Post('lots')
  lot(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Body() dto: LotFromHarvestsDto) {
    return this.agriculture.lotFromHarvests(org, user.userId, dto);
  }

  @Get('lots')
  lots(@ActingOrg() org: ActingOrganization, @Query() query: LotsQueryDto) {
    return this.agriculture.listLots(org, query.status, query);
  }

  @Post('lots/:lotId/split')
  split(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Id('lotId') lotId: string, @Body() dto: SplitDto) {
    return this.agriculture.split(org, user.userId, lotId, dto.quantities);
  }

  @Post('lots/merge')
  merge(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Body() dto: MergeDto) {
    return this.agriculture.merge(org, user.userId, dto.lotIds, dto.grade);
  }

  @Post('lots/:lotId/grade')
  grade(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Id('lotId') lotId: string, @Body() dto: GradeDto) {
    return this.agriculture.grade(org, user.userId, lotId, dto);
  }

  /** Where this lot came from: every parent lot, harvest, season and farm. */
  @Get('lots/:lotId/trace')
  trace(@ActingOrg() org: ActingOrganization, @Id('lotId') lotId: string) {
    return this.agriculture.trace(org, lotId);
  }
}

/** Retries stock postings Inventory didn't accept yet (e.g. it was briefly down). */
@Injectable()
export class StockPostingRetryJob implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(StockPostingRetryJob.name);
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;

  constructor(private readonly agriculture: AgricultureService) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => {
      this.running ??= this.agriculture
        .flush()
        .catch((error) => this.logger.error(`Stock posting retry failed: ${error}`))
        .finally(() => (this.running = null));
    }, 30_000);
  }

  async beforeApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
