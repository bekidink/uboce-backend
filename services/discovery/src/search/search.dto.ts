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

  /** Category or sector slug, e.g. `coffee` or `agriculture` (includes everything under it). */
  @IsOptional()
  @Matches(/^[a-z0-9-]{1,64}$/)
  category?: string;

  /** Supplier business types, comma-separated, e.g. `manufacturer,wholesaler`. */
  @IsOptional()
  @Matches(/^[a-z_]{2,40}(,[a-z_]{2,40}){0,8}$/)
  supplierType?: string;

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

  /** Largest acceptable minimum order quantity. */
  @IsOptional()
  @Matches(DECIMAL_PATTERN)
  maxMoq?: string;

  /** Only products the supplier has in stock (or makes to order). */
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  inStock = false;

  /** Minimum average supplier rating (1–5). */
  @IsOptional()
  @Matches(/^[1-5](\.\d)?$/)
  minRating?: string;

  /** A region or city the supplier delivers to (or has a pickup point in). */
  @IsOptional()
  @IsString()
  @Length(2, 100)
  deliversTo?: string;

  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : value === true || value === 'true'))
  @IsBoolean()
  madeToOrder?: boolean;

  /** in_season: orderable now; preorder: season not open yet; any (default): both. */
  @ApiPropertyOptional({ enum: ['any', 'in_season', 'preorder'], default: 'any' })
  @IsOptional()
  @IsIn(['any', 'in_season', 'preorder'])
  availability: 'any' | 'in_season' | 'preorder' = 'any';

  /** Attribute filters, e.g. `grade:1,process:washed`. */
  @IsOptional()
  @IsString()
  @Length(3, 500)
  attributes?: string;

  /** Also return counts per category, country, attribute value and the price span. */
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  facets = false;

  @ApiPropertyOptional({ enum: ['relevance', 'newest', 'price_asc', 'price_desc', 'rating'], default: 'relevance' })
  @IsOptional()
  @IsIn(['relevance', 'newest', 'price_asc', 'price_desc', 'rating'])
  sort: 'relevance' | 'newest' | 'price_asc' | 'price_desc' | 'rating' = 'relevance';
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

  @IsOptional()
  @Matches(/^[1-5](\.\d)?$/)
  minRating?: string;

  @IsOptional()
  @IsString()
  @Length(2, 100)
  deliversTo?: string;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  verifiedOnly = false;
}
