import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { type ActingOrganization, ActingOrg, ActsForOrganization, type AuthUser, badRequest, CurrentUser, IsCurrency, IsDecimalString, PaginationQueryDto } from '@uboce/common';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsBoolean, IsDateString, IsIn, IsOptional, IsString, IsUUID, Length, ValidateNested } from 'class-validator';

import { CollectionsService, type ManualMethod } from './collections.service.js';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;
const idempotencyKey = (key?: string) => {
  if (key !== undefined && !IDEMPOTENCY_KEY.test(key)) throw badRequest('invalid_idempotency_key', 'Idempotency-Key must be 8–100 letters, digits, - or _');
  return key;
};

class OpenSessionDto {
  @IsCurrency()
  currency: string;

  @IsDecimalString('500.00')
  openingFloat: string;

  @IsOptional()
  @IsUUID()
  branchId?: string;
}

class CloseSessionDto {
  @IsDecimalString('12450.00')
  countedAmount: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  note?: string;
}

class SessionQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(['open', 'closed'])
  status?: 'open' | 'closed';

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  mine?: boolean;
}

class ManualPaymentDto {
  @IsIn(['cash', 'mobile_money', 'cheque', 'bank_transfer'])
  method: ManualMethod;

  @IsDecimalString('1250.00')
  amount: string;

  /** The payer's reference: mobile money transaction ID, cheque number, transfer reference. */
  @IsOptional()
  @IsString()
  @Length(1, 120)
  externalReference?: string;

  /** Defaults to your open till for cash. */
  @IsOptional()
  @IsUUID()
  sessionId?: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  note?: string;
}

class RejectClaimDto {
  @IsString()
  @Length(3, 500)
  note: string;
}

class StatementLineDto {
  @IsDateString()
  bookedAt: string;

  @IsDecimalString('1250.00')
  amount: string;

  @IsCurrency()
  currency: string;

  @IsString()
  @Length(0, 500)
  reference: string;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  counterparty?: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  description?: string;
}

class ImportStatementDto {
  /** Which bank account, e.g. "CBE 1000123456789". */
  @IsString()
  @Length(2, 100)
  accountLabel: string;

  /** Currency for CSV rows that don't name one. */
  @IsCurrency()
  currency: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  fileName?: string;

  /** The bank's CSV export (header row with date, amount/credit and reference columns). Send this or `lines`. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(10, 2_000_000)
  csv?: string;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => StatementLineDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(5000)
  lines?: StatementLineDto[];
}

class LineQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(['unmatched', 'matched', 'ignored'])
  status?: 'unmatched' | 'matched' | 'ignored';
}

class MatchLineDto {
  @IsUUID()
  invoiceId: string;
}

class MatchDepositDto {
  @IsUUID()
  sessionId: string;
}

class IgnoreLineDto {
  @IsString()
  @Length(3, 300)
  reason: string;
}

const Uuid = (name: string) => Param(name, new ParseUUIDPipe());

@ApiTags('collections')
@ApiBearerAuth()
@ActsForOrganization()
@Controller()
export class CollectionsController {
  constructor(private readonly collections: CollectionsService) {}

  // ---- Tills (FIN-04)

  @Post('cash-sessions')
  open(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Body() dto: OpenSessionDto) {
    return this.collections.openSession(org, user.userId, dto);
  }

  @Get('cash-sessions')
  sessions(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Query() query: SessionQueryDto) {
    return this.collections.listSessions(org, user.userId, query);
  }

  @Get('cash-sessions/:sessionId')
  session(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Uuid('sessionId') sessionId: string) {
    return this.collections.getSession(org, user.userId, sessionId);
  }

  @Post('cash-sessions/:sessionId/close')
  @HttpCode(200)
  close(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Uuid('sessionId') sessionId: string, @Body() dto: CloseSessionDto) {
    return this.collections.closeSession(org, user.userId, sessionId, dto);
  }

  // ---- Manual payments (FIN-04) and claim review (FIN-06)

  @Post('invoices/:invoiceId/manual-payments')
  record(
    @ActingOrg() org: ActingOrganization,
    @CurrentUser() user: AuthUser,
    @Uuid('invoiceId') invoiceId: string,
    @Body() dto: ManualPaymentDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.collections.recordPayment(org, user.userId, invoiceId, dto, idempotencyKey(key));
  }

  @Post('invoices/:invoiceId/payments/:paymentId/reject')
  @HttpCode(200)
  reject(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Uuid('invoiceId') invoiceId: string, @Uuid('paymentId') paymentId: string, @Body() dto: RejectClaimDto) {
    return this.collections.rejectClaim(org, user.userId, invoiceId, paymentId, dto.note);
  }

  @Get('receipts/:number')
  receipt(@ActingOrg() org: ActingOrganization, @Param('number') number: string) {
    return this.collections.receipt(org, number);
  }

  // ---- Bank reconciliation (FIN-06)

  @Post('bank-statements')
  importStatement(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Body() dto: ImportStatementDto) {
    if (!dto.csv === !dto.lines) throw badRequest('csv_or_lines', 'Send either csv or lines');
    return this.collections.importStatement(org, user.userId, dto);
  }

  @Get('bank-statements/lines')
  lines(@ActingOrg() org: ActingOrganization, @Query() query: LineQueryDto) {
    return this.collections.listLines(org, query);
  }

  @Post('bank-statements/lines/:lineId/match')
  @HttpCode(200)
  match(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Uuid('lineId') lineId: string, @Body() dto: MatchLineDto) {
    return this.collections.matchLine(org, user.userId, lineId, dto.invoiceId);
  }

  @Post('bank-statements/lines/:lineId/deposit')
  @HttpCode(200)
  deposit(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Uuid('lineId') lineId: string, @Body() dto: MatchDepositDto) {
    return this.collections.matchDeposit(org, user.userId, lineId, dto.sessionId);
  }

  @Post('bank-statements/lines/:lineId/ignore')
  @HttpCode(200)
  ignore(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Uuid('lineId') lineId: string, @Body() dto: IgnoreLineDto) {
    return this.collections.ignoreLine(org, user.userId, lineId, dto.reason);
  }
}
