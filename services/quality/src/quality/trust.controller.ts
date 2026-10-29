import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import {
  type ActingOrganization,
  ActingOrg,
  ActsForOrganization,
  type AuthUser,
  CurrentUser,
  IsDecimalString,
  PaginationQueryDto,
  Public,
  RequiresPlatformRole,
} from '@uboce/common';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import { TrustService } from './trust.service.js';

class SpecParameterDto {
  @IsString()
  @Length(1, 100)
  name: string;

  @IsOptional()
  @IsString()
  @Length(1, 50)
  target?: string;

  @IsOptional()
  @IsDecimalString('0')
  min?: string;

  @IsOptional()
  @IsDecimalString('11.5')
  max?: string;

  @IsOptional()
  @IsString()
  @Length(1, 20)
  unit?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  method?: string;
}

class SpecDto {
  @IsUUID()
  productId: string;

  @IsString()
  @Length(2, 150)
  name: string;

  @ApiProperty({ type: [SpecParameterDto] })
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => SpecParameterDto)
  parameters: SpecParameterDto[];
}

const CERT_KINDS = ['organic', 'fairtrade', 'rainforest_alliance', 'haccp', 'iso_9001', 'iso_22000', 'halal', 'ecx_grade', 'export_permit', 'other'] as const;

class CertificationDto {
  @IsOptional()
  @IsUUID()
  productId?: string;

  @ApiProperty({ enum: CERT_KINDS })
  @IsIn(CERT_KINDS)
  kind: string;

  @IsString()
  @Length(2, 100)
  certificateNumber: string;

  @IsString()
  @Length(2, 150)
  issuer: string;

  @IsDateString()
  issuedAt: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  /** The certificate, uploaded to Documents. */
  @IsOptional()
  @IsUUID()
  documentId?: string;
}

const CLAIM_REASONS = ['moisture', 'contamination', 'wrong_grade', 'damaged', 'short_weight', 'wrong_item', 'expired', 'other'] as const;

class ClaimDto {
  @IsUUID()
  orderId: string;

  @IsOptional()
  @IsUUID()
  orderLineId?: string;

  @ApiProperty({ enum: CLAIM_REASONS })
  @IsIn(CLAIM_REASONS)
  reason: string;

  @IsString()
  @Length(10, 3000)
  description: string;

  @IsOptional()
  @IsDecimalString('25')
  affectedQuantity?: string;

  @IsOptional()
  @IsUUID('all', { each: true })
  @ArrayMaxSize(10)
  evidenceDocumentIds?: string[];
}

class ClaimResponseDto {
  @IsIn(['accept', 'reject'])
  decision: 'accept' | 'reject';

  @ApiPropertyOptional({ enum: ['replacement', 'refund', 'credit', 'price_adjustment'] })
  @IsOptional()
  @IsIn(['replacement', 'refund', 'credit', 'price_adjustment'])
  resolution?: string;

  @IsString()
  @Length(3, 3000)
  response: string;
}

class ClaimActionDto {
  @IsIn(['resolve', 'escalate'])
  action: 'resolve' | 'escalate';
}

class ListClaimsDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(['buyer', 'supplier'])
  side?: 'buyer' | 'supplier';

  @IsOptional()
  @IsIn(['open', 'accepted', 'rejected', 'escalated', 'resolved'])
  status?: string;
}

class ReviewDto {
  @IsUUID()
  orderId: string;

  /** Review one product on the order; leave out to review the business. */
  @IsOptional()
  @IsUUID()
  productId?: string;

  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  @IsOptional()
  @IsString()
  @Length(0, 150)
  title?: string;

  @IsOptional()
  @IsString()
  @Length(0, 3000)
  body?: string;
}

class ReplyDto {
  @IsString()
  @Length(2, 2000)
  reply: string;
}

class ModerateDto {
  @IsIn(['publish', 'hide', 'reject'])
  decision: 'publish' | 'hide' | 'reject';

  @IsOptional()
  @IsString()
  @Length(0, 500)
  note?: string;
}

class PublicReviewsDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @IsOptional()
  @IsUUID()
  productId?: string;
}

class RatingsDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value))
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  ids: string[];
}

/** Public trust signals: anyone (signed in or not) can read them. */
@ApiTags('quality')
@Controller('quality')
export class PublicTrustController {
  constructor(private readonly trust: TrustService) {}

  @Public()
  @Get('reviews')
  reviews(@Query() query: PublicReviewsDto) {
    return this.trust.publicReviews({ organizationId: query.organizationId, productId: query.productId }, query);
  }

  /** Average rating and count per organization (business reviews). */
  @Public()
  @Get('ratings')
  ratings(@Query() query: RatingsDto) {
    return this.trust.ratings(query.ids);
  }

  @Public()
  @Get('products/:productId')
  product(@Param('productId', new ParseUUIDPipe()) productId: string) {
    return this.trust.productQuality(productId);
  }

  @Public()
  @Get('organizations/:organizationId/certifications')
  certifications(@Param('organizationId', new ParseUUIDPipe()) id: string) {
    return this.trust.certifications(id);
  }

  @Public()
  @Get('organizations/:organizationId/scorecards')
  scorecards(@Param('organizationId', new ParseUUIDPipe()) id: string) {
    return this.trust.scorecards(id);
  }
}

@ApiTags('quality')
@ApiBearerAuth()
@ActsForOrganization()
@Controller('quality')
export class TrustController {
  constructor(private readonly trust: TrustService) {}

  @Get('specs')
  specs(@ActingOrg() org: ActingOrganization) {
    return this.trust.listSpecs(org);
  }

  /** Publishes a new spec version for a product. */
  @Post('specs')
  spec(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Body() dto: SpecDto) {
    return this.trust.publishSpec(org, user.userId, dto);
  }

  @Post('certifications')
  certify(@ActingOrg() org: ActingOrganization, @Body() dto: CertificationDto) {
    return this.trust.addCertification(org, dto);
  }

  @Post('certifications/:id/revoke')
  @HttpCode(200)
  revoke(@ActingOrg() org: ActingOrganization, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.trust.revokeCertification(org, id);
  }

  @Post('claims')
  claim(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Body() dto: ClaimDto) {
    return this.trust.openClaim(org, user.userId, dto);
  }

  @Get('claims')
  claims(@ActingOrg() org: ActingOrganization, @Query() query: ListClaimsDto) {
    return this.trust.listClaims(org, query.side ?? 'buyer', query);
  }

  @Get('claims/:id')
  getClaim(@ActingOrg() org: ActingOrganization, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.trust.getClaim(org, id);
  }

  /** Supplier: accept with a remedy, or reject. */
  @Post('claims/:id/response')
  @HttpCode(200)
  respond(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: ClaimResponseDto) {
    return this.trust.respondToClaim(org, user.userId, id, dto);
  }

  /** Buyer: resolve, or escalate a rejected claim. */
  @Post('claims/:id/action')
  @HttpCode(200)
  claimAction(@ActingOrg() org: ActingOrganization, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: ClaimActionDto) {
    return this.trust.buyerClaimAction(org, id, dto.action);
  }

  /** Verified review of a delivered order's supplier (or one of its products). */
  @Post('reviews')
  review(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Body() dto: ReviewDto) {
    return this.trust.review(org, user.userId, dto);
  }

  /** Reviews about my organization, to read and reply to. */
  @Get('reviews/received')
  received(@ActingOrg() org: ActingOrganization, @Query() query: PaginationQueryDto) {
    return this.trust.receivedReviews(org, query);
  }

  @Post('reviews/:id/reply')
  @HttpCode(200)
  reply(@ActingOrg() org: ActingOrganization, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: ReplyDto) {
    return this.trust.reply(org, id, dto.reply);
  }
}

/** Platform staff: reviews held for moderation. */
@ApiTags('quality')
@ApiBearerAuth()
@RequiresPlatformRole('support')
@Controller('quality/moderation')
export class ModerationController {
  constructor(private readonly trust: TrustService) {}

  @Get('reviews')
  queue(@Query() query: PaginationQueryDto) {
    return this.trust.moderationQueue(query);
  }

  @Post('reviews/:id')
  @HttpCode(200)
  moderate(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: ModerateDto) {
    return this.trust.moderate(user.userId, id, dto.decision, dto.note);
  }

  /** Recompute this month's scorecards now. */
  @Post('scorecards/run')
  @HttpCode(200)
  run() {
    return this.trust.snapshotAll();
  }
}
