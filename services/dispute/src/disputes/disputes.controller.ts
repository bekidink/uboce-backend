import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import {
  type ActingOrganization,
  ActingOrg,
  ActsForOrganization,
  type AuthUser,
  CurrentUser,
  PaginationQueryDto,
  RequiresPlatformRole,
} from '@uboce/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';

import { DisputeStatus, Outcome, SubjectType } from '../generated/prisma/enums.js';
import { PerformanceService } from '../performance/performance.js';
import { DisputesService } from './disputes.service.js';

class OpenDisputeDto {
  @ApiProperty({ enum: SubjectType })
  @IsEnum(SubjectType)
  subjectType: SubjectType;

  @IsUUID()
  subjectId: string;

  /** The order both organizations share. */
  @IsUUID()
  orderId: string;

  @IsIn(['quality', 'quantity', 'delivery', 'payment', 'documentation', 'other'])
  category: string;

  @IsString()
  @Length(10, 5000)
  description: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  evidenceDocumentIds?: string[];
}

class StatementDto {
  @IsString()
  @Length(2, 5000)
  text: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  evidenceDocumentIds?: string[];
}

class AppealDto {
  @IsString()
  @Length(10, 5000)
  reason: string;
}

class ResolveDto {
  @ApiProperty({ enum: Outcome })
  @IsEnum(Outcome)
  outcome: Outcome;

  @IsString()
  @Length(10, 5000)
  summary: string;

  /** What the parties or owning services should do (e.g. "seller issues a credit note for 5 bags"). */
  @IsOptional()
  @IsString()
  @Length(0, 2000)
  followUpActions?: string;
}

class ListDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: DisputeStatus })
  @IsOptional()
  @IsEnum(DisputeStatus)
  status?: DisputeStatus;
}

class QueueDto extends PaginationQueryDto {
  @IsIn(['open', 'under_review'])
  status: 'open' | 'under_review' = 'open';
}

class WindowDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(7)
  @Max(365)
  days = 90;
}

const Id = () => Param('disputeId', new ParseUUIDPipe());

@ApiTags('disputes')
@ApiBearerAuth()
@ActsForOrganization()
@Controller('disputes')
export class DisputesController {
  constructor(private readonly disputes: DisputesService) {}

  @Post()
  open(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Body() dto: OpenDisputeDto) {
    return this.disputes.open(org, user.userId, dto);
  }

  @Get()
  list(@ActingOrg() org: ActingOrganization, @Query() query: ListDto) {
    return this.disputes.listForParty(org, query.status, query);
  }

  @Get(':disputeId')
  get(@ActingOrg() org: ActingOrganization, @Id() id: string) {
    return this.disputes.get(org, id);
  }

  @Post(':disputeId/statements')
  statement(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Id() id: string, @Body() dto: StatementDto) {
    return this.disputes.addStatement(org, user.userId, id, dto.text, dto.evidenceDocumentIds);
  }

  @Post(':disputeId/withdraw')
  withdraw(@ActingOrg() org: ActingOrganization, @Id() id: string) {
    return this.disputes.withdraw(org, id);
  }

  @Post(':disputeId/appeal')
  appeal(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Id() id: string, @Body() dto: AppealDto) {
    return this.disputes.appeal(org, user.userId, id, dto.reason);
  }
}

/** Platform dispute reviewers. */
@ApiTags('dispute-review')
@ApiBearerAuth()
@RequiresPlatformRole('dispute_reviewer')
@Controller('disputes-review')
export class DisputeReviewController {
  constructor(private readonly disputes: DisputesService) {}

  @Get()
  queue(@Query() query: QueueDto) {
    return this.disputes.queue(query.status, query);
  }

  @Get(':disputeId')
  get(@Id() id: string) {
    return this.disputes.reviewerGet(id);
  }

  @Post(':disputeId/claim')
  claim(@CurrentUser() user: AuthUser, @Id() id: string) {
    return this.disputes.claim(user.userId, id);
  }

  @Post(':disputeId/statements')
  statement(@CurrentUser() user: AuthUser, @Id() id: string, @Body() dto: StatementDto) {
    return this.disputes.reviewerStatement(user.userId, id, dto.text);
  }

  @Post(':disputeId/resolve')
  resolve(@CurrentUser() user: AuthUser, @Id() id: string, @Body() dto: ResolveDto) {
    return this.disputes.resolve(user.userId, id, dto.outcome, dto.summary, dto.followUpActions);
  }
}

/** Reproducible supplier scores, for buyers choosing suppliers (PRD 5.18). */
@ApiTags('performance')
@ApiBearerAuth()
@Controller('performance')
export class PerformanceController {
  constructor(private readonly performance: PerformanceService) {}

  @Get('suppliers/:organizationId')
  supplier(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Query() query: WindowDto) {
    return this.performance.supplier(organizationId, query.days);
  }
}
