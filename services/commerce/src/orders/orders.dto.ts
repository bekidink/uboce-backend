import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsCurrency, IsDecimalString, PaginationQueryDto } from '@uboce/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsEnum, IsOptional, IsString, IsUUID, Length, Matches, ValidateNested } from 'class-validator';

import { OrderStatus } from '../generated/prisma/enums.js';

export class OrderLineDto {
  @IsOptional()
  @IsUUID()
  productId?: string;

  @IsString()
  @Length(2, 500)
  description: string;

  @IsDecimalString('100')
  quantity: string;

  @Matches(/^[a-z_]{1,20}$/)
  unitOfMeasure: string;

  @IsDecimalString('42.50')
  unitPrice: string;
}

/** An order placed directly with a supplier, without an RFQ. */
export class CreateDirectOrderDto {
  @IsUUID()
  supplierOrganizationId: string;

  @IsCurrency()
  currency: string;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  title?: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  deliveryTerms?: string;

  @IsOptional()
  @IsString()
  @Length(0, 300)
  deliveryLocation?: string;

  @ApiProperty({ type: [OrderLineDto] })
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => OrderLineDto)
  lines: OrderLineDto[];
}

export class ReasonDto {
  @IsOptional()
  @IsString()
  @Length(0, 500)
  reason?: string;
}

export class ListOrdersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: OrderStatus })
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  /** Find the order created from an accepted quotation. */
  @IsOptional()
  @IsUUID()
  quotationId?: string;
}
