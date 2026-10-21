import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsCurrency, IsDecimalString, PaginationQueryDto } from '@uboce/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsBoolean,
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
}

export class CreateProductDto {
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

export class UpdateProductDto {
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
