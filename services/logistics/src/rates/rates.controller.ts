import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController, ApiTags } from '@nestjs/swagger';
import { type ActingOrganization, ActingOrg, ActsForOrganization, type AuthUser, CurrentUser, Internal, IsCurrency, IsDecimalString } from '@uboce/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsOptional, IsString, IsUUID, Length, ValidateNested } from 'class-validator';

import { RatesService } from './rates.service.js';

class ZoneDto {
  @IsString()
  @Length(1, 80)
  name: string;

  /** Cities or regions, e.g. ["Addis Ababa"]; ["*"] for everywhere else. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @Length(1, 80, { each: true })
  areas: string[];

  @IsDecimalString('150.00')
  baseFee: string;

  @IsDecimalString('2.50')
  perKgFee: string;

  @IsOptional()
  @IsDecimalString('500')
  maxWeightKg?: string | null;
}

class RateCardDto {
  @IsCurrency()
  currency: string;

  /** Orders worth at least this much (after discounts) ship free. */
  @IsOptional()
  @IsDecimalString('5000.00')
  freeOverAmount?: string | null;

  @ValidateNested({ each: true })
  @Type(() => ZoneDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  zones: ZoneDto[];
}

class OwnQuoteDto {
  @IsCurrency()
  currency: string;

  @IsDecimalString('1250.00')
  goodsAmount: string;

  @IsDecimalString('12.5')
  weightKg: string;

  @IsOptional()
  @IsString()
  @Length(0, 120)
  city?: string | null;

  @IsOptional()
  @IsString()
  @Length(0, 120)
  region?: string | null;
}

class DeliveryQuoteDto extends OwnQuoteDto {
  @IsUUID()
  sellerOrganizationId: string;
}

@ApiTags('delivery rates')
@ApiBearerAuth()
@ActsForOrganization()
@Controller('rate-cards')
export class RatesController {
  constructor(private readonly rates: RatesService) {}

  @Get('current')
  current(@ActingOrg() org: ActingOrganization, @Query('currency') currency?: string) {
    return this.rates.current(org, currency && /^[A-Z]{3}$/.test(currency) ? currency : 'ETB');
  }

  @Get()
  history(@ActingOrg() org: ActingOrganization) {
    return this.rates.history(org);
  }

  /** Publishes a new version; orders already placed keep the version they were priced with. */
  @Put()
  publish(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Body() dto: RateCardDto) {
    return this.rates.publish(org, user.userId, dto);
  }

  @Delete(':currency')
  withdraw(@ActingOrg() org: ActingOrganization, @Param('currency') currency: string) {
    return this.rates.withdraw(org, currency.toUpperCase());
  }

  /** What delivery would cost (for showing in a seller's own tools). */
  @Post('quote')
  @HttpCode(200)
  quote(@ActingOrg() org: ActingOrganization, @Body() dto: OwnQuoteDto) {
    return this.rates.quote({ ...dto, sellerOrganizationId: org.organization.id });
  }
}

@ApiExcludeController()
@Controller('internal/delivery-quotes')
export class InternalRatesController {
  constructor(private readonly rates: RatesService) {}

  @Internal('commerce')
  @Post()
  @HttpCode(200)
  quote(@Body() dto: DeliveryQuoteDto) {
    return this.rates.quote(dto);
  }
}
