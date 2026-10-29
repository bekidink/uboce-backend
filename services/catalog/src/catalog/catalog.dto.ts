import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsCurrency, IsDecimalString, PaginationQueryDto } from '@uboce/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsBoolean,
  IsDateString,
  IsInt,
  Max,
  Min,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  ValidateNested,
} from 'class-validator';

import { ProductStatus, UnitOfMeasure } from '../generated/prisma/enums.js';

const SKU = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class VariantDto {
  @Matches(SKU, { message: 'sku may contain letters, digits, dot, dash and underscore (max 64)' })
  sku: string;

  @IsString()
  @Length(1, 150)
  name: string;

  @IsDecimalString('4500.00')
  price: string;

  @IsCurrency()
  currency: string;

  @IsOptional()
  @IsDecimalString('10')
  minOrderQuantity?: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: { type: 'string' } })
  @IsOptional()
  @IsObject()
  attributes?: Record<string, string>;

  /** GTIN/EAN/UPC barcode. */
  @IsOptional()
  @Matches(/^\d{8,14}$/, { message: 'barcode must be 8–14 digits' })
  barcode?: string | null;

  /** Units of the product's unit of measure per pack, e.g. 50 (kg per bag). */
  @IsOptional()
  @IsDecimalString('50')
  packSize?: string | null;

  @IsOptional()
  @IsBoolean()
  tracksBatches?: boolean;

  @IsOptional()
  @IsBoolean()
  tracksExpiry?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  shelfLifeDays?: number | null;
}

export class UpdateVariantDto {
  @IsOptional()
  @IsString()
  @Length(1, 150)
  name?: string;

  @IsOptional()
  @IsDecimalString('4500.00')
  price?: string;

  @IsOptional()
  @IsDecimalString('10')
  minOrderQuantity?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /** GTIN/EAN/UPC barcode. */
  @IsOptional()
  @Matches(/^\d{8,14}$/, { message: 'barcode must be 8–14 digits' })
  barcode?: string | null;

  /** Units of the product's unit of measure per pack, e.g. 50 (kg per bag). */
  @IsOptional()
  @IsDecimalString('50')
  packSize?: string | null;

  @IsOptional()
  @IsBoolean()
  tracksBatches?: boolean;

  @IsOptional()
  @IsBoolean()
  tracksExpiry?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  shelfLifeDays?: number | null;
}

export class ProductAvailabilityDto {
  /** Season start; before it, the product can only be pre-ordered (if allowed). */
  @IsOptional()
  @IsDateString()
  availableFrom?: string | null;

  @IsOptional()
  @IsDateString()
  availableUntil?: string | null;

  @IsOptional()
  @IsBoolean()
  allowPreorder?: boolean;

  @IsOptional()
  @IsBoolean()
  madeToOrder?: boolean;

  /** Days to produce or prepare the order. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  leadTimeDays?: number | null;
}

export class CreateProductDto extends ProductAvailabilityDto {
  @IsString()
  @Length(2, 200)
  name: string;

  @IsOptional()
  @IsString()
  @Length(0, 5000)
  description?: string;

  @IsUUID()
  categoryId: string;

  @ApiProperty({ enum: UnitOfMeasure })
  @IsEnum(UnitOfMeasure)
  unitOfMeasure: UnitOfMeasure;

  /** Category specification values; see `requiredAttributes` on the category. */
  @ApiPropertyOptional({ type: 'object', additionalProperties: { type: 'string' }, example: { origin: 'Yirgacheffe', grade: '1', process: 'washed' } })
  @IsOptional()
  @IsObject()
  attributes?: Record<string, string>;

  @ApiPropertyOptional({ type: [VariantDto] })
  @IsOptional()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => VariantDto)
  variants?: VariantDto[];
}

export class UpdateProductDto extends ProductAvailabilityDto {
  @IsOptional()
  @IsString()
  @Length(2, 200)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(0, 5000)
  description?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ enum: UnitOfMeasure })
  @IsOptional()
  @IsEnum(UnitOfMeasure)
  unitOfMeasure?: UnitOfMeasure;

  @ApiPropertyOptional({ type: 'object', additionalProperties: { type: 'string' } })
  @IsOptional()
  @IsObject()
  attributes?: Record<string, string>;
}

export class ListProductsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ProductStatus })
  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;
}

// ---- Addendum 2.3–2.4: media, options, tiers, price lists, availability ---------------

export class MediaItemDto {
  /** A Document (classification product_image) uploaded by your organization. */
  @IsUUID()
  documentId: string;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  altText?: string;
}

export class ProductMediaDto {
  /** In display order; the first is the primary image. */
  @ApiProperty({ type: [MediaItemDto] })
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => MediaItemDto)
  items: MediaItemDto[];
}

export class OptionDto {
  @IsString()
  @Length(1, 100)
  name: string;

  /** Added to the unit price (may be 0). */
  @IsOptional()
  @IsDecimalString('35.00')
  priceDelta?: string;
}

export class OptionGroupDto {
  @IsString()
  @Length(1, 100)
  name: string;

  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @IsOptional()
  @IsBoolean()
  multiple?: boolean;

  @ApiProperty({ type: [OptionDto] })
  @ArrayMinSize(1)
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => OptionDto)
  options: OptionDto[];
}

export class ProductOptionsDto {
  @ApiProperty({ type: [OptionGroupDto] })
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => OptionGroupDto)
  groups: OptionGroupDto[];
}

export class PriceTierDto {
  @IsDecimalString('100')
  minQuantity: string;

  @IsDecimalString('420.00')
  unitPrice: string;
}

export class PriceTiersDto {
  @ApiProperty({ type: [PriceTierDto] })
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => PriceTierDto)
  tiers: PriceTierDto[];
}

export class PriceListEntryDto {
  @IsUUID()
  variantId: string;

  @IsOptional()
  @IsDecimalString('0')
  minQuantity?: string;

  @IsDecimalString('400.00')
  unitPrice: string;
}

export class PriceListDto {
  @IsString()
  @Length(2, 150)
  name: string;

  @IsCurrency()
  currency: string;

  /** Buyers this list is for; empty means every buyer. */
  @IsOptional()
  @IsUUID('all', { each: true })
  @ArrayMaxSize(500)
  buyerOrganizationIds?: string[];

  /** Only orders fulfilled from this location of yours. */
  @IsOptional()
  @IsUUID()
  branchId?: string | null;

  @IsOptional()
  @IsDateString()
  startsAt?: string | null;

  @IsOptional()
  @IsDateString()
  endsAt?: string | null;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ type: [PriceListEntryDto] })
  @IsOptional()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => PriceListEntryDto)
  entries?: PriceListEntryDto[];
}

export class QuoteLineDto {
  @IsUUID()
  variantId: string;

  @IsDecimalString('100')
  quantity: string;

  @IsOptional()
  @IsUUID('all', { each: true })
  @ArrayMaxSize(30)
  optionIds?: string[];
}

/** Internal (Commerce) and buyer-facing price check. */
export class QuoteDto {
  @IsUUID()
  supplierOrganizationId: string;

  @IsUUID()
  buyerOrganizationId: string;

  @IsCurrency()
  currency: string;

  @IsOptional()
  @IsUUID()
  branchId?: string | null;

  @ApiProperty({ type: [QuoteLineDto] })
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => QuoteLineDto)
  lines: QuoteLineDto[];
}

/** What a buyer sends to preview prices (their organization comes from the header). */
export class PriceCheckDto {
  @IsUUID()
  supplierOrganizationId: string;

  @IsCurrency()
  currency: string;

  @ApiProperty({ type: [QuoteLineDto] })
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => QuoteLineDto)
  lines: QuoteLineDto[];
}
