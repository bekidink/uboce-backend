import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController, ApiTags } from '@nestjs/swagger';
import { type ActingOrganization, ActingOrg, ActsForOrganization, type AuthUser, badRequest, CurrentUser, Internal, IsDecimalString, RequiresPlatformRole } from '@uboce/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsBoolean, IsDateString, IsIn, IsOptional, IsString, IsUUID, Length, Matches, ValidateNested } from 'class-validator';

import { TaxService } from './tax.service.js';

const TAX_CLASSES = ['standard', 'zero_rated', 'exempt', 'service'];

class TaxProfileDto {
  @IsIn(['vat', 'tot', 'none'])
  regime: 'vat' | 'tot' | 'none';

  @IsOptional()
  @IsString()
  @Length(0, 20)
  tin?: string | null;

  @IsOptional()
  @IsString()
  @Length(0, 40)
  vatNumber?: string | null;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  legalName?: string | null;

  @IsOptional()
  @IsBoolean()
  pricesIncludeTax?: boolean;
}

class TaxRuleDto {
  @Matches(/^[A-Za-z]{2,10}$/)
  code: string;

  @IsString()
  @Length(2, 120)
  name: string;

  @IsIn(['vat', 'tot'])
  regime: 'vat' | 'tot';

  @IsIn(TAX_CLASSES)
  taxClass: string;

  @Matches(/^\d{1,2}(\.\d{1,2})?$/)
  ratePct: string;

  @IsDateString()
  effectiveFrom: string;
}

class ExemptionDto {
  @IsString()
  @Length(2, 60)
  certificateNumber: string;

  /** The scanned certificate, uploaded to the document service. */
  @IsUUID()
  documentId: string;

  @IsDateString()
  validFrom: string;

  @IsDateString()
  validTo: string;
}

class ReviewDto {
  @IsBoolean()
  approve: boolean;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  note?: string;
}

class SummaryQueryDto {
  @IsDateString()
  from: string;

  @IsDateString()
  to: string;
}

class QuoteLineDto {
  @IsString()
  @Length(1, 64)
  key: string;

  @IsDecimalString('1250.00')
  amount: string;

  @IsOptional()
  @IsIn(TAX_CLASSES)
  taxClass?: string | null;
}

class TaxQuoteDto {
  @IsUUID()
  sellerOrganizationId: string;

  @IsUUID()
  buyerOrganizationId: string;

  @IsString()
  @Length(3, 3)
  currency: string;

  @ValidateNested({ each: true })
  @Type(() => QuoteLineDto)
  @ArrayMaxSize(500)
  lines: QuoteLineDto[];
}

@ApiTags('tax')
@ApiBearerAuth()
@ActsForOrganization()
@Controller('tax')
export class TaxController {
  constructor(private readonly tax: TaxService) {}

  /** Your organization's tax registration: regime, TIN, VAT number, and whether prices include tax. */
  @Get('profile')
  profile(@ActingOrg() org: ActingOrganization) {
    return this.tax.profile(org);
  }

  @Put('profile')
  saveProfile(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Body() dto: TaxProfileDto) {
    return this.tax.saveProfile(org, user.userId, dto);
  }

  @Get('rules')
  rules() {
    return this.tax.rules();
  }

  @Get('exemptions')
  exemptions(@ActingOrg() org: ActingOrganization) {
    return this.tax.exemptions(org);
  }

  /** A buyer's exemption certificate; it applies once a platform reviewer approves it. */
  @Post('exemptions')
  submit(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Body() dto: ExemptionDto) {
    return this.tax.submitExemption(org, user.userId, dto);
  }

  /** Output tax by rate for a period, for the seller's return. */
  @Get('summary')
  summary(@ActingOrg() org: ActingOrganization, @Query() q: SummaryQueryDto) {
    const from = new Date(q.from);
    const to = new Date(q.to);
    if (to <= from) throw badRequest('invalid_period', '`to` must be after `from`');
    return this.tax.summary(org, from, to);
  }
}

/** Platform tax administration: rates and exemption review. */
@ApiTags('tax')
@ApiBearerAuth()
@RequiresPlatformRole('platform_admin')
@Controller('tax/admin')
export class TaxAdminController {
  constructor(private readonly tax: TaxService) {}

  @Post('rules')
  addRule(@CurrentUser() user: AuthUser, @Body() dto: TaxRuleDto) {
    return this.tax.addRule(user.userId, dto);
  }

  @Get('exemptions')
  pending() {
    return this.tax.pendingExemptions();
  }

  @Post('exemptions/:id/review')
  @HttpCode(200)
  review(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: ReviewDto) {
    return this.tax.reviewExemption(user.userId, id, dto.approve, dto.note);
  }
}

@ApiExcludeController()
@Controller('internal/tax')
export class InternalTaxController {
  constructor(private readonly tax: TaxService) {}

  @Internal('commerce', 'finance')
  @Post('quote')
  @HttpCode(200)
  quote(@Body() dto: TaxQuoteDto) {
    return this.tax.quote(dto);
  }
}
