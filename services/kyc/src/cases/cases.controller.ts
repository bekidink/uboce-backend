import {
  Body,
  Controller,
  Get,
  Injectable,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { type AuthUser, type CaseStatus, CurrentUser, Internal, PaginationQueryDto, RequiresPlatformRole, JobRegistry } from '@uboce/common';
import { IsIn, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';

import { CasesService, type SubjectContext } from './cases.service.js';
import { TIERS } from './policy.js';

class OpenCaseDto {
  @IsIn(Object.keys(TIERS))
  tier: string;
}

class EvidenceDto {
  @Matches(/^[a-z_]{2,40}$/)
  requirement: string;

  @IsUUID()
  documentId: string;
}

class QueueDto extends PaginationQueryDto {
  @IsIn(['submitted', 'in_review', 'needs_information', 'approved', 'suspended'])
  status: CaseStatus = 'submitted';
}

class CheckDto {
  @Matches(/^[a-z_]{2,50}$/)
  type: string;

  @IsIn(['pass', 'fail', 'inconclusive'])
  result: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  details?: string;
}

class DecisionDto {
  @IsIn(['approved', 'rejected', 'needs_information'])
  decision: 'approved' | 'rejected' | 'needs_information';

  @Matches(/^[a-z][a-z0-9_]{2,49}$/)
  reasonCode: string;

  /** Internal: never shown to the subject. */
  @IsOptional()
  @IsString()
  @Length(0, 4000)
  notes?: string;
}

class SuspendDto {
  @Matches(/^[a-z][a-z0-9_]{2,49}$/)
  reasonCode: string;

  @IsOptional()
  @IsString()
  @Length(0, 4000)
  notes?: string;
}

const CaseId = () => Param('caseId', new ParseUUIDPipe());

const subject = (user: AuthUser): SubjectContext => ({
  subjectId: user.userId,
  actorUserId: user.userId,
  ownsDocument: (doc) => doc.ownerUserId === user.userId && doc.ownerOrganizationId === null,
});

/** The person verifying themselves. */
@ApiTags('kyc')
@ApiBearerAuth()
@Controller('kyc/cases')
export class KycController {
  constructor(private readonly cases: CasesService) {}

  @Post()
  open(@CurrentUser() user: AuthUser, @Body() dto: OpenCaseDto) {
    return this.cases.open(subject(user), dto.tier);
  }

  @Get()
  mine(@CurrentUser() user: AuthUser) {
    return this.cases.mine(user.userId);
  }

  /** Attach one of your uploaded personal documents (no x-organization-id). */
  @Post(':caseId/evidence')
  evidence(@CurrentUser() user: AuthUser, @CaseId() caseId: string, @Body() dto: EvidenceDto) {
    return this.cases.addEvidence(subject(user), caseId, dto.requirement, dto.documentId);
  }

  @Post(':caseId/submit')
  submit(@CurrentUser() user: AuthUser, @CaseId() caseId: string) {
    return this.cases.submit(subject(user), caseId);
  }
}

/** Platform verification reviewers. */
@ApiTags('kyc-review')
@ApiBearerAuth()
@RequiresPlatformRole('verification_reviewer')
@Controller('kyc/review/cases')
export class KycReviewController {
  constructor(private readonly cases: CasesService) {}

  @Get()
  queue(@Query() query: QueueDto) {
    return this.cases.queue(query.status, query);
  }

  @Get(':caseId')
  get(@CaseId() caseId: string) {
    return this.cases.reviewerView(caseId);
  }

  @Post(':caseId/claim')
  claim(@CurrentUser() user: AuthUser, @CaseId() caseId: string) {
    return this.cases.claim(user.userId, caseId, async (subjectId) => subjectId === user.userId);
  }

  @Post(':caseId/checks')
  check(@CurrentUser() user: AuthUser, @CaseId() caseId: string, @Body() dto: CheckDto) {
    return this.cases.recordCheck(user.userId, caseId, dto);
  }

  @Post(':caseId/decision')
  decide(@CurrentUser() user: AuthUser, @CaseId() caseId: string, @Body() dto: DecisionDto) {
    return this.cases.decide(user.userId, caseId, dto.decision, dto.reasonCode, dto.notes);
  }

  @Post(':caseId/suspend')
  suspend(@CurrentUser() user: AuthUser, @CaseId() caseId: string, @Body() dto: SuspendDto) {
    return this.cases.suspend(user.userId, caseId, dto.reasonCode, dto.notes);
  }
}

@Controller('internal/kyc')
export class InternalKycController {
  constructor(private readonly cases: CasesService) {}

  @ApiExcludeEndpoint()
  @Internal()
  @Get('status/:subjectId')
  status(@Param('subjectId', new ParseUUIDPipe()) subjectId: string) {
    return this.cases.status(subjectId);
  }
}

/** Expires approvals past their validity; triggered by the scheduler (PRD v2 ORG-11, PLT-03). */
@Injectable()
export class ExpiryJob {
  constructor(jobs: JobRegistry, cases: CasesService) {
    jobs.register('verification.expire', () => cases.expireDue());
  }
}
