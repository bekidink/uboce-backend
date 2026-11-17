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
import {
  type ActingOrganization,
  ActingOrg,
  ActsForOrganization,
  type AuthUser,
  type CaseStatus,
  CurrentUser,
  Internal,
  OrganizationsClient,
  PaginationQueryDto,
  requireRole,
  RequiresPlatformRole,
  JobRegistry,
} from '@uboce/common';
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
  /** e.g. registry_lookup, license_authenticity, beneficial_owner_screening */
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

  /** Internal: never shown to the organization. */
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
const MANAGERS = ['owner', 'admin'];

const subject = (org: ActingOrganization, user: AuthUser): SubjectContext => ({
  subjectId: org.organization.id,
  actorUserId: user.userId,
  ownsDocument: (doc) => doc.ownerOrganizationId === org.organization.id,
});

/** An organization's owners/admins verify the business. */
@ApiTags('kyb')
@ApiBearerAuth()
@ActsForOrganization()
@Controller('kyb/cases')
export class KybController {
  constructor(private readonly cases: CasesService) {}

  @Post()
  open(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Body() dto: OpenCaseDto) {
    requireRole(org, MANAGERS, 'start business verification');
    return this.cases.open(subject(org, user), dto.tier);
  }

  @Get()
  mine(@ActingOrg() org: ActingOrganization) {
    return this.cases.mine(org.organization.id);
  }

  /** Attach a document uploaded under this organization (x-organization-id). */
  @Post(':caseId/evidence')
  evidence(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @CaseId() caseId: string, @Body() dto: EvidenceDto) {
    requireRole(org, MANAGERS, 'add verification evidence');
    return this.cases.addEvidence(subject(org, user), caseId, dto.requirement, dto.documentId);
  }

  @Post(':caseId/submit')
  submit(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @CaseId() caseId: string) {
    requireRole(org, MANAGERS, 'submit verification');
    return this.cases.submit(subject(org, user), caseId);
  }
}

/** Platform verification reviewers. */
@ApiTags('kyb-review')
@ApiBearerAuth()
@RequiresPlatformRole('verification_reviewer')
@Controller('kyb/review/cases')
export class KybReviewController {
  constructor(
    private readonly cases: CasesService,
    private readonly organizations: OrganizationsClient,
  ) {}

  @Get()
  queue(@Query() query: QueueDto) {
    return this.cases.queue(query.status, query);
  }

  @Get(':caseId')
  get(@CaseId() caseId: string) {
    return this.cases.reviewerView(caseId);
  }

  /** Members of the organization can't review its verification. */
  @Post(':caseId/claim')
  claim(@CurrentUser() user: AuthUser, @CaseId() caseId: string) {
    return this.cases.claim(user.userId, caseId, async (organizationId) => !!(await this.organizations.getMembership(organizationId, user.userId)));
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

@Controller('internal/kyb')
export class InternalKybController {
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
