import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsCurrency, IsDecimalString, PaginationQueryDto } from '@uboce/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import { RfqStatus, RfqVisibility } from './generated/prisma/enums.js';

export class RfqLineDto {
  @IsOptional()
  @IsUUID()
  productId?: string;

  @IsString()
  @Length(2, 500)
  description: string;

  @IsDecimalString('100')
  quantity: string;

  /** Catalog unit, e.g. kg, quintal, tonne, piece. */
  @Matches(/^[a-z_]{1,20}$/)
  unitOfMeasure: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: { type: 'string' } })
  @IsOptional()
  @IsObject()
  specifications?: Record<string, string>;
}

export class CreateRfqDto {
  @IsString()
  @Length(3, 200)
  title: string;

  @IsOptional()
  @IsString()
  @Length(0, 5000)
  description?: string;

  @IsCurrency()
  currency: string;

  /** e.g. "DAP Addis Ababa, within 30 days" */
  @IsOptional()
  @IsString()
  @Length(0, 500)
  deliveryTerms?: string;

  @IsOptional()
  @IsString()
  @Length(0, 300)
  deliveryLocation?: string;

  /** ISO 8601; must be in the future when the RFQ is published. */
  @IsDateString()
  responseDeadline: string;

  @ApiProperty({ enum: RfqVisibility, default: RfqVisibility.invited })
  @IsOptional()
  @IsEnum(RfqVisibility)
  visibility?: RfqVisibility;

  /** Required for invited RFQs. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  invitedSupplierOrganizationIds?: string[];

  @ApiProperty({ type: [RfqLineDto] })
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => RfqLineDto)
  lines: RfqLineDto[];
}

export class QuotationLineDto {
  @IsUUID()
  rfqLineId: string;

  /** Price per unit of the RFQ line, in the RFQ's currency. */
  @IsDecimalString('42.50')
  unitPrice: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3650)
  leadTimeDays?: number;
}

export class SubmitQuotationDto {
  /** ISO 8601. The buyer can't accept the quotation after this. */
  @IsDateString()
  validUntil: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  notes?: string;

  @ApiProperty({ type: [QuotationLineDto] })
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => QuotationLineDto)
  lines: QuotationLineDto[];
}

export class ListRfqsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: RfqStatus })
  @IsOptional()
  @IsEnum(RfqStatus)
  status?: RfqStatus;
}
