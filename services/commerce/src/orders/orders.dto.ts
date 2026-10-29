import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsCurrency, IsDecimalString, PaginationQueryDto } from '@uboce/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import { FulfillmentMethod, OrderStatus, ReturnStatus } from '../generated/prisma/enums.js';

/**
 * A catalog line (variantId: priced by Catalog — tiers, price lists, options) or a
 * free-text line (description + unitPrice, for goods not in the catalog).
 */
export class OrderLineDto {
  /** Catalog variant. The price comes from the catalog, never from the request. */
  @IsOptional()
  @IsUUID()
  variantId?: string;

  @IsOptional()
  @IsUUID('all', { each: true })
  @ArrayMaxSize(30)
  optionIds?: string[];

  /** Legacy; catalog lines must use variantId. */
  @IsOptional()
  @IsUUID()
  productId?: string;

  /** Free-text lines only. */
  @IsOptional()
  @IsString()
  @Length(2, 500)
  description?: string;

  @IsDecimalString('100')
  quantity: string;

  /** Free-text lines only. */
  @IsOptional()
  @Matches(/^[a-z_]{1,20}$/)
  unitOfMeasure?: string;

  /** Free-text lines only; ignored for catalog lines. */
  @IsOptional()
  @IsDecimalString('42.50')
  unitPrice?: string;
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

  @ApiPropertyOptional({ enum: FulfillmentMethod, default: FulfillmentMethod.delivery })
  @IsOptional()
  @IsEnum(FulfillmentMethod)
  fulfillmentMethod?: FulfillmentMethod;

  /** The supplier's location: required for pickup (a pickup point), optional otherwise. */
  @IsOptional()
  @IsUUID()
  fulfillmentBranchId?: string;

  /** A supplier coupon. Automatic promotions apply without one. */
  @IsOptional()
  @Matches(/^[A-Za-z0-9_-]{3,40}$/)
  couponCode?: string;

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

export class FulfillmentLocationDto {
  @IsUUID()
  branchId: string;

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

  @IsOptional()
  @IsUUID()
  fulfillmentBranchId?: string;
}

// ---- Cancellation policies -----------------------------------------------------------

export class CancellationPolicyDto {
  @IsString()
  @Length(2, 150)
  name: string;

  @IsInt()
  @Min(0)
  @Max(720)
  freeCancellationHours: number;

  @ApiProperty({ example: '10' })
  @Matches(/^\d{1,3}(\.\d{1,2})?$/)
  cancellationFeePct: string;

  @ApiProperty({ example: '5' })
  @Matches(/^\d{1,3}(\.\d{1,2})?$/)
  noShowFeePct: string;

  @IsInt()
  @Min(0)
  @Max(365)
  returnWindowDays: number;

  @ApiProperty({ example: '15' })
  @Matches(/^\d{1,3}(\.\d{1,2})?$/)
  restockingFeePct: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(720)
  pickupHoldHours?: number;

  @IsOptional()
  @IsString()
  @Length(0, 5000)
  terms?: string;
}

// ---- Returns ------------------------------------------------------------------------------

export class ReturnLineDto {
  @IsUUID()
  orderLineId: string;

  @IsDecimalString('5')
  quantity: string;
}

export class CreateReturnDto {
  @IsString()
  @Length(5, 1000)
  reason: string;

  @ApiProperty({ type: [ReturnLineDto] })
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ReturnLineDto)
  lines: ReturnLineDto[];

  @IsOptional()
  @IsUUID('all', { each: true })
  @ArrayMaxSize(10)
  evidenceDocumentIds?: string[];
}

export class ReturnDecisionDto {
  @IsIn(['approve', 'reject'])
  decision: 'approve' | 'reject';

  @IsOptional()
  @IsString()
  @Length(0, 1000)
  note?: string;
}

export class ListReturnsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ReturnStatus })
  @IsOptional()
  @IsEnum(ReturnStatus)
  status?: ReturnStatus;
}

// ---- Promotions ------------------------------------------------------------------------------

export class PromotionDto {
  @IsString()
  @Length(2, 150)
  name: string;

  /** Coupon code buyers enter; leave empty for an automatic promotion. */
  @IsOptional()
  @Matches(/^[A-Za-z0-9_-]{3,40}$/)
  code?: string | null;

  @IsIn(['percent', 'fixed'])
  kind: 'percent' | 'fixed';

  @IsDecimalString('10')
  value: string;

  @IsCurrency()
  currency: string;

  @IsOptional()
  @IsDecimalString('1000')
  minSubtotal?: string | null;

  @IsOptional()
  @IsDecimalString('500')
  maxDiscount?: string | null;

  @IsOptional()
  @IsDateString()
  startsAt?: string | null;

  @IsOptional()
  @IsDateString()
  endsAt?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  usageLimit?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  perBuyerLimit?: number | null;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsString()
  @Length(0, 300)
  description?: string | null;

  /** Show it to buyers; turn off for private coupons. */
  @IsOptional()
  @IsBoolean()
  advertised?: boolean;
}

export class OffersQueryDto extends PaginationQueryDto {
  /** One supplier's offers; leave out for offers from all suppliers. */
  @IsOptional()
  @IsUUID()
  supplierOrganizationId?: string;
}

export class CouponCheckDto {
  @IsUUID()
  supplierOrganizationId: string;

  @IsCurrency()
  currency: string;

  @IsDecimalString('1000')
  subtotal: string;

  @IsOptional()
  @Matches(/^[A-Za-z0-9_-]{3,40}$/)
  couponCode?: string;
}
