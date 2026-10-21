import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class PaginationQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}

export interface Page<T> {
  items: T[];
  meta: { page: number; limit: number; total: number };
}

export const toPage = <T>(items: T[], total: number, q: PaginationQueryDto): Page<T> => ({
  items,
  meta: { page: q.page, limit: q.limit, total },
});

export const skipTake = (q: PaginationQueryDto) => ({ skip: (q.page - 1) * q.limit, take: q.limit });
