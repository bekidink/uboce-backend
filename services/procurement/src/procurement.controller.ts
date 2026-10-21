import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { type ActingOrganization, ActingOrg, ActsForOrganization, type AuthUser, CurrentUser } from '@uboce/common';

import { CreateRfqDto, ListRfqsQueryDto, SubmitQuotationDto } from './procurement.dto.js';
import { ProcurementService } from './procurement.service.js';

const RfqId = () => Param('rfqId', new ParseUUIDPipe());
const QuotationId = () => Param('quotationId', new ParseUUIDPipe());

@ApiTags('rfqs')
@ApiBearerAuth()
@ActsForOrganization()
@Controller('rfqs')
export class RfqsController {
  constructor(private readonly procurement: ProcurementService) {}

  @Post()
  create(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Body() dto: CreateRfqDto) {
    return this.procurement.createRfq(org, user.userId, dto);
  }

  /** Your organization's RFQs (as buyer). */
  @Get()
  list(@ActingOrg() org: ActingOrganization, @Query() query: ListRfqsQueryDto) {
    return this.procurement.listBuyerRfqs(org, query);
  }

  /** RFQs your organization can quote on (as supplier). */
  @Get('open')
  open(@ActingOrg() org: ActingOrganization, @Query() query: ListRfqsQueryDto) {
    return this.procurement.listOpenRfqs(org, query);
  }

  @Get(':rfqId')
  get(@ActingOrg() org: ActingOrganization, @RfqId() rfqId: string) {
    return this.procurement.getRfq(org, rfqId);
  }

  @Post(':rfqId/publish')
  publish(@ActingOrg() org: ActingOrganization, @RfqId() rfqId: string) {
    return this.procurement.publishRfq(org, rfqId);
  }

  @Post(':rfqId/cancel')
  cancel(@ActingOrg() org: ActingOrganization, @RfqId() rfqId: string) {
    return this.procurement.cancelRfq(org, rfqId);
  }

  /** Buyer: all quotations on this RFQ, cheapest first. */
  @Get(':rfqId/quotations')
  compare(@ActingOrg() org: ActingOrganization, @RfqId() rfqId: string) {
    return this.procurement.compareQuotations(org, rfqId);
  }

  /** Supplier: submit, or revise your existing quotation. */
  @Post(':rfqId/quotations')
  submit(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @RfqId() rfqId: string, @Body() dto: SubmitQuotationDto) {
    return this.procurement.submitQuotation(org, user.userId, rfqId, dto);
  }

  /** Buyer: award the RFQ. Creates exactly one purchase order. */
  @Post(':rfqId/quotations/:quotationId/accept')
  accept(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @RfqId() rfqId: string, @QuotationId() quotationId: string) {
    return this.procurement.acceptQuotation(org, user.userId, rfqId, quotationId);
  }
}

@ApiTags('quotations')
@ApiBearerAuth()
@ActsForOrganization()
@Controller('quotations')
export class QuotationsController {
  constructor(private readonly procurement: ProcurementService) {}

  /** Your organization's quotations (as supplier). */
  @Get()
  list(@ActingOrg() org: ActingOrganization, @Query() query: ListRfqsQueryDto) {
    return this.procurement.listMyQuotations(org, query);
  }

  /** Includes every earlier revision. */
  @Get(':quotationId')
  get(@ActingOrg() org: ActingOrganization, @QuotationId() quotationId: string) {
    return this.procurement.getMyQuotation(org, quotationId);
  }

  @Post(':quotationId/withdraw')
  withdraw(@ActingOrg() org: ActingOrganization, @QuotationId() quotationId: string) {
    return this.procurement.withdrawQuotation(org, quotationId);
  }
}
