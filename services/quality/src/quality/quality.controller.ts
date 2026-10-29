import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
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
import { ArrayMaxSize, ArrayMinSize, IsArray, IsEnum, IsIn, IsObject, IsOptional, IsString, IsUUID, Length, ValidateNested } from 'class-validator';

import { Decision, Severity, SubjectType } from '../generated/prisma/enums.js';
import { QualityService } from './quality.service.js';

class OpenLineDto {
  @IsUUID()
  itemId: string;

  @IsDecimalString('100')
  quantity: string;
}

class OpenInspectionDto {
  @ApiProperty({ enum: ['produce_lot', 'batch', 'product'] })
  @IsIn(['produce_lot', 'batch', 'product'])
  subjectType: SubjectType;

  @IsUUID()
  subjectId: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: { type: 'string' } })
  @IsOptional()
  @IsObject()
  criteria?: Record<string, string>;

  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => OpenLineDto)
  lines: OpenLineDto[];
}

class ResultLineDto {
  @IsUUID()
  itemId: string;

  @IsDecimalString('48')
  acceptedQuantity: string;

  @IsDecimalString('2')
  rejectedQuantity: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  notes?: string;
}

class NonconformanceDto {
  @IsString()
  @Length(3, 1000)
  description: string;

  @ApiProperty({ enum: Severity })
  @IsEnum(Severity)
  severity: Severity;
}

class ResultsDto {
  @ApiProperty({ enum: Decision })
  @IsEnum(Decision)
  decision: Decision;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  notes?: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: { type: 'string' } })
  @IsOptional()
  @IsObject()
  criteria?: Record<string, string>;

  /** Photos or lab reports uploaded through the Document service. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  evidenceDocumentIds?: string[];

  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ResultLineDto)
  lines: ResultLineDto[];

  @IsOptional()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => NonconformanceDto)
  nonconformances?: NonconformanceDto[];
}

class CloseDto {
  @IsString()
  @Length(3, 2000)
  correctiveAction: string;
}

class ListDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(['pending', 'completed'])
  status?: 'pending' | 'completed';
}

@ApiTags('quality')
@ApiBearerAuth()
@ActsForOrganization()
@RequiresModule('quality')
@Controller('quality')
export class QualityController {
  constructor(private readonly quality: QualityService) {}

  @Post('inspections')
  open(@ActingOrg() org: ActingOrganization, @Body() dto: OpenInspectionDto) {
    return this.quality.open(org, dto.subjectType, dto.subjectId, dto.lines, dto.criteria);
  }

  @Get('inspections')
  list(@ActingOrg() org: ActingOrganization, @Query() query: ListDto) {
    return this.quality.list(org, query.status, query);
  }

  @Get('inspections/:id')
  get(@ActingOrg() org: ActingOrganization, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.quality.get(org, id);
  }

  @Post('inspections/:id/results')
  record(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: ResultsDto) {
    return this.quality.record(org, user.userId, id, dto);
  }

  @Post('nonconformances/:id/close')
  close(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: CloseDto) {
    return this.quality.closeNonconformance(org, user.userId, id, dto.correctiveAction);
  }
}
