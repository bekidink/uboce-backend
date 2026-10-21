import { ApiPropertyOptional } from '@nestjs/swagger';
import { DECIMAL_PATTERN, PaginationQueryDto } from '@uboce/common';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';

export class SearchProductsQueryDto extends PaginationQueryDto {
  /** Free text over name, description and category; prefix matching. */
  @IsOptional()
  @IsString()
  @Length(1, 200)
  q?: string;

  /** Category slug, e.g. `coffee`. */
  @IsOptional()
  @Matches(/^[a-z0-9-]{1,64}$/)
  category?: string;

  /** ISO 3166-1 alpha-2 country of the supplier. */
  @IsOptional()
  @Matches(/^[A-Z]{2}$/)
  country?: string;

  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @IsOptional()
  @Matches(/^[A-Z]{3}$/)
  currency?: string;

  @IsOptional()
  @Matches(DECIMAL_PATTERN)
  minPrice?: string;

  @IsOptional()
  @Matches(DECIMAL_PATTERN)
  maxPrice?: string;

  /** Only suppliers whose business verification (KYB) is complete. */
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  verifiedOnly = false;

  @ApiPropertyOptional({ enum: ['relevance', 'newest', 'price_asc', 'price_desc'], default: 'relevance' })
  @IsOptional()
  @IsIn(['relevance', 'newest', 'price_asc', 'price_desc'])
  sort: 'relevance' | 'newest' | 'price_asc' | 'price_desc' = 'relevance';
}

export class SearchSuppliersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @Length(1, 100)
  q?: string;

  @IsOptional()
  @Matches(/^[A-Z]{2}$/)
  country?: string;

  @IsOptional()
  @Matches(/^[a-z_]{2,40}$/)
  type?: string;
}
