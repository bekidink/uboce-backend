import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import {
  type ActingOrganization,
  ActingOrg,
  ActsForOrganization,
  type AuthUser,
  badRequest,
  CurrentUser,
  Internal,
  IsCurrency,
  IsDecimalString,
  PaginationQueryDto,
} from '@uboce/common';
import { IsDateString, IsEmail, IsIn, IsOptional, IsString, Length } from 'class-validator';

import { env } from '../config.js';
import { InvoicesService } from '../invoices/invoices.service.js';
import { PaymentsService } from './payments.service.js';

class PayDto {
  /** One of GET /payments/providers. */
  @IsString()
  @Length(2, 30)
  provider: string;

  /** Receipt email for providers that ask for one. */
  @IsOptional()
  @IsEmail()
  email?: string;
}

class SandboxOutcomeDto {
  @IsIn(['succeeded', 'failed'])
  outcome: 'succeeded' | 'failed';
}

class RefundDto {
  @IsString()
  invoiceId: string;

  @IsDecimalString('100.00')
  amount: string;

  @IsString()
  @Length(3, 500)
  reason: string;
}

class ApproveRefundDto {
  @IsIn(['provider', 'manual'])
  method: 'provider' | 'manual';
}

class RejectDto {
  @IsString()
  @Length(3, 500)
  reason: string;
}

class ReferenceDto {
  @IsString()
  @Length(2, 200)
  reference: string;
}

class ListRefundsDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['seller', 'buyer'] })
  @IsOptional()
  @IsIn(['seller', 'buyer'])
  side?: 'seller' | 'buyer';

  @IsOptional()
  @IsIn(['requested', 'approved', 'processing', 'succeeded', 'failed', 'rejected'])
  status?: string;
}

class SettlementRunDto {
  @IsString()
  provider: string;

  @IsCurrency()
  currency: string;

  @IsDateString()
  from: string;

  @IsDateString()
  to: string;
}

class RefundNotificationDto {
  @IsString()
  provider: string;

  @IsString()
  refundNumber: string;

  @IsIn(['succeeded', 'failed'])
  status: 'succeeded' | 'failed';

  @IsOptional()
  @IsString()
  providerRef?: string;

  @IsOptional()
  @IsString()
  reason?: string;
}

@ApiTags('payments')
@ApiBearerAuth()
@Controller()
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly invoices: InvoicesService,
  ) {}

  /** Payment methods buyers can choose. */
  @Get('payments/providers')
  providers() {
    return this.payments.listProviders();
  }

  /** Start paying an invoice online; send the buyer to checkoutUrl. */
  @ActsForOrganization()
  @Post('invoices/:invoiceId/pay')
  pay(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Param('invoiceId', new ParseUUIDPipe()) id: string, @Body() dto: PayDto) {
    return this.payments.pay(org, user.userId, id, dto.provider, dto.email);
  }

  @ActsForOrganization()
  @Get('invoices/:invoiceId/payment-intents')
  intents(@ActingOrg() org: ActingOrganization, @Param('invoiceId', new ParseUUIDPipe()) id: string) {
    return this.payments.intents(org, id);
  }

  @ActsForOrganization()
  @Get('payments/intents/:intentId')
  intent(@ActingOrg() org: ActingOrganization, @Param('intentId', new ParseUUIDPipe()) id: string) {
    return this.payments.intent(org, id);
  }

  /** Sandbox only: finish a test payment as if the provider had called back. */
  @ActsForOrganization()
  @Post('payments/intents/:intentId/sandbox')
  @HttpCode(200)
  async sandbox(@ActingOrg() org: ActingOrganization, @Param('intentId', new ParseUUIDPipe()) id: string, @Body() dto: SandboxOutcomeDto) {
    if (!env.PAYMENT_PROVIDERS.split(',').includes('sandbox')) throw badRequest('sandbox_disabled', 'Test payments are disabled');
    const intent = await this.payments.intent(org, id);
    if (intent.provider !== 'sandbox' || intent.invoice.buyerOrganizationId !== org.organization.id) throw badRequest('not_sandbox', 'Not a test payment');
    await this.invoices.providerNotification({
      provider: 'sandbox',
      externalReference: intent.providerRef,
      invoiceNumber: intent.invoice.number,
      amount: intent.amount.toString(),
      currency: intent.currency,
      status: dto.outcome === 'succeeded' ? 'confirmed' : 'failed',
      occurredAt: new Date().toISOString(),
    });
    return this.payments.intent(org, id);
  }

  // ---- Refunds ----

  @ActsForOrganization()
  @Get('refunds')
  refunds(@ActingOrg() org: ActingOrganization, @Query() query: ListRefundsDto) {
    return this.payments.listRefunds(org, query.side ?? 'seller', query);
  }

  @ActsForOrganization()
  @Get('refunds/:refundId')
  refund(@ActingOrg() org: ActingOrganization, @Param('refundId', new ParseUUIDPipe()) id: string) {
    return this.payments.getRefund(org, id);
  }

  @ActsForOrganization()
  @Post('refunds')
  createRefund(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Body() dto: RefundDto) {
    return this.payments.createRefund(org, user.userId, dto);
  }

  @ActsForOrganization()
  @Post('refunds/:refundId/approve')
  @HttpCode(200)
  approve(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Param('refundId', new ParseUUIDPipe()) id: string, @Body() dto: ApproveRefundDto) {
    return this.payments.approveRefund(org, user.userId, id, dto.method);
  }

  @ActsForOrganization()
  @Post('refunds/:refundId/reject')
  @HttpCode(200)
  reject(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Param('refundId', new ParseUUIDPipe()) id: string, @Body() dto: RejectDto) {
    return this.payments.rejectRefund(org, user.userId, id, dto.reason);
  }

  /** Manual refunds: the seller sent the money and records the transfer reference. */
  @ActsForOrganization()
  @Post('refunds/:refundId/paid')
  @HttpCode(200)
  paid(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Param('refundId', new ParseUUIDPipe()) id: string, @Body() dto: ReferenceDto) {
    return this.payments.markRefundPaid(org, user.userId, id, dto.reference);
  }

  // ---- Settlements ----

  @ActsForOrganization()
  @Get('settlements')
  settlements(@ActingOrg() org: ActingOrganization, @Query() query: PaginationQueryDto) {
    return this.payments.listSettlements(org, query);
  }

  /** Reconcile a provider payout period against recorded payments, fees and refunds. */
  @ActsForOrganization()
  @Post('settlements')
  runSettlement(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Body() dto: SettlementRunDto) {
    return this.payments.runSettlement(org, user.userId, dto);
  }

  @ActsForOrganization()
  @Post('settlements/:settlementId/paid')
  @HttpCode(200)
  settlementPaid(@ActingOrg() org: ActingOrganization, @Param('settlementId', new ParseUUIDPipe()) id: string, @Body() dto: ReferenceDto) {
    return this.payments.markSettlementPaid(org, id, dto.reference);
  }
}

@ApiExcludeController()
@Controller('internal/refund-notifications')
export class InternalRefundsController {
  constructor(private readonly payments: PaymentsService) {}

  @Internal('integration')
  @Post()
  @HttpCode(200)
  notify(@Body() dto: RefundNotificationDto) {
    return this.payments.refundNotification(dto);
  }
}
