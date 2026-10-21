import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import {
  type ActingOrganization,
  ActingOrg,
  ActsForOrganization,
  type AuthUser,
  CurrentUser,
  Internal,
  IsCurrency,
  IsDecimalString,
  PaginationQueryDto,
} from '@uboce/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsDateString, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min, ValidateNested } from 'class-validator';

import { InvoiceStatus } from '../generated/prisma/enums.js';
import { InvoicesService } from './invoices.service.js';

const TAX_RATE = /^\d{1,2}(\.\d{1,2})?$/;

class FromOrderDto {
  @IsUUID()
  orderId: string;

  /** Applied to every line, e.g. "15" for 15% VAT. */
  @Matches(TAX_RATE)
  taxRatePct: string;

  @IsInt()
  @Min(0)
  @Max(365)
  dueInDays: number;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  notes?: string;
}

class LineDto {
  @IsString()
  @Length(1, 300)
  description: string;

  @IsDecimalString('2')
  quantity: string;

  @IsDecimalString('1500.00')
  unitPrice: string;

  @Matches(TAX_RATE)
  taxRatePct: string;
}

class ManualInvoiceDto {
  @IsUUID()
  buyerOrganizationId: string;

  @IsCurrency()
  currency: string;

  @IsInt()
  @Min(0)
  @Max(365)
  dueInDays: number;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  notes?: string;

  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => LineDto)
  lines: LineDto[];
}

class ReasonDto {
  @IsString()
  @Length(5, 500)
  reason: string;
}

class CreditNoteDto extends ReasonDto {
  @IsDecimalString('500.00')
  amount: string;
}

class ClaimDto {
  /** e.g. bank_transfer, cash, or the payment provider used. */
  @Matches(/^[a-z][a-z0-9_]{1,39}$/)
  provider: string;

  @IsString()
  @Length(3, 100)
  externalReference: string;

  @IsDecimalString('1051050.00')
  amount: string;

  @IsDateString()
  paidAt: string;
}

class ListDto extends PaginationQueryDto {
  /** `receivable`: invoices you issued. `payable`: invoices you owe. */
  @IsIn(['receivable', 'payable'])
  direction: 'receivable' | 'payable' = 'receivable';

  @ApiPropertyOptional({ enum: InvoiceStatus })
  @IsOptional()
  @IsEnum(InvoiceStatus)
  status?: InvoiceStatus;
}

class PaymentNotificationDto {
  @IsString()
  @Length(2, 50)
  provider: string;

  @IsString()
  @Length(1, 200)
  externalReference: string;

  @IsString()
  @Length(5, 50)
  invoiceNumber: string;

  @IsDecimalString()
  amount: string;

  @Matches(/^[A-Z]{3}$/)
  currency: string;

  @IsIn(['confirmed', 'failed', 'reversed'])
  status: 'confirmed' | 'failed' | 'reversed';

  @IsDateString()
  occurredAt: string;
}

const Id = () => Param('invoiceId', new ParseUUIDPipe());

@ApiTags('invoices')
@ApiBearerAuth()
@ActsForOrganization()
@Controller('invoices')
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Post('from-order')
  fromOrder(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Body() dto: FromOrderDto) {
    return this.invoices.fromOrder(org, user.userId, dto);
  }

  @Post()
  manual(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Body() dto: ManualInvoiceDto) {
    return this.invoices.manual(org, user.userId, dto);
  }

  @Get()
  list(@ActingOrg() org: ActingOrganization, @Query() query: ListDto) {
    return this.invoices.list(org, query.direction === 'receivable' ? 'seller' : 'buyer', query.status, query);
  }

  @Get(':invoiceId')
  get(@ActingOrg() org: ActingOrganization, @Id() id: string) {
    return this.invoices.get(org, id);
  }

  @Post(':invoiceId/issue')
  issue(@ActingOrg() org: ActingOrganization, @Id() id: string) {
    return this.invoices.issue(org, id);
  }

  @Post(':invoiceId/void')
  void(@ActingOrg() org: ActingOrganization, @Id() id: string, @Body() dto: ReasonDto) {
    return this.invoices.void(org, id, dto.reason);
  }

  @Post(':invoiceId/credit-notes')
  creditNote(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Id() id: string, @Body() dto: CreditNoteDto) {
    return this.invoices.creditNote(org, user.userId, id, dto.amount, dto.reason);
  }

  /** Buyer: report a payment. It stays pending until the provider or seller confirms it. */
  @Post(':invoiceId/payments')
  claim(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Id() id: string, @Body() dto: ClaimDto) {
    return this.invoices.claimPayment(org, user.userId, id, dto);
  }

  /** Seller: confirm money actually received. */
  @Post(':invoiceId/payments/:paymentId/confirm')
  confirm(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Id() id: string, @Param('paymentId', new ParseUUIDPipe()) paymentId: string) {
    return this.invoices.confirmPayment(org, user.userId, id, paymentId);
  }
}

@ApiExcludeController()
@Controller('internal/payment-notifications')
export class InternalPaymentsController {
  constructor(private readonly invoices: InvoicesService) {}

  @Internal('integration')
  @Post()
  @HttpCode(200)
  notify(@Body() dto: PaymentNotificationDto) {
    return this.invoices.providerNotification(dto);
  }
}
