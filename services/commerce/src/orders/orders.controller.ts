import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiHeader, ApiTags } from '@nestjs/swagger';
import { type ActingOrganization, ActingOrg, ActsForOrganization, type AuthUser, badRequest, CurrentUser, Internal, PaginationQueryDto, Public, RequiresModule } from '@uboce/common';
import type { Response } from 'express';

import {
  CancellationPolicyDto,
  CouponCheckDto,
  CreateDirectOrderDto,
  CreateReturnDto,
  FulfillmentLocationDto,
  ListOrdersQueryDto,
  ListReturnsQueryDto,
  OffersQueryDto,
  PromotionDto,
  ReasonDto,
  ReturnDecisionDto,
} from './orders.dto.js';
import { OrdersService } from './orders.service.js';
import { PoliciesService } from './policies.service.js';
import { PromotionsService } from './promotions.service.js';
import { ReportsService } from './reports.service.js';
import { ReturnsService } from './returns.service.js';

const OrderId = () => Param('orderId', new ParseUUIDPipe());
const ReturnId = () => Param('returnId', new ParseUUIDPipe());
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;

/** The buyer's side of orders. */
@ApiTags('purchase-orders')
@ApiBearerAuth()
@ActsForOrganization()
@Controller('purchase-orders')
export class PurchaseOrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly returns: ReturnsService,
  ) {}

  /** Place an order directly with a supplier. Retrying with the same Idempotency-Key returns the same order. */
  @ApiHeader({ name: 'idempotency-key', required: true, description: '8–100 chars, unique per order you mean to place' })
  @Post()
  async create(
    @ActingOrg() org: ActingOrganization,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: CreateDirectOrderDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!key || !IDEMPOTENCY_KEY.test(key)) {
      throw badRequest('idempotency_key_required', 'Send an Idempotency-Key header (8–100 letters, digits, - or _)');
    }
    const { order, replayed } = await this.orders.createDirect(org, user.userId, key, dto);
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader('idempotent-replayed', 'true');
    return order;
  }

  @Get()
  list(@ActingOrg() org: ActingOrganization, @Query() query: ListOrdersQueryDto) {
    return this.orders.list(org, 'buyer', query);
  }

  @Get(':orderId')
  get(@ActingOrg() org: ActingOrganization, @OrderId() orderId: string) {
    return this.orders.get(org, 'buyer', orderId);
  }

  @Post(':orderId/cancel')
  cancel(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @OrderId() orderId: string, @Body() dto: ReasonDto) {
    return this.orders.cancel(org, 'buyer', user.userId, orderId, dto.reason?.trim() || null);
  }

  /** Close a fully delivered order. */
  @Post(':orderId/close')
  close(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @OrderId() orderId: string) {
    return this.orders.close(org, user.userId, orderId);
  }

  /** Ask to return delivered goods, within the order's return window. */
  @Post(':orderId/returns')
  requestReturn(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @OrderId() orderId: string, @Body() dto: CreateReturnDto) {
    return this.returns.request(org, user.userId, orderId, dto);
  }
}

/** The supplier's side of the same orders. */
@ApiTags('sales-orders')
@ApiBearerAuth()
@ActsForOrganization()
@Controller('sales-orders')
export class SalesOrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly reports: ReportsService,
  ) {}

  /** Store / location report: orders, sales, fulfilment, returns and top products per location (?from=&to= YYYY-MM-DD). */
  @Get('reports/locations')
  locationReport(@ActingOrg() org: ActingOrganization, @Query('from') from?: string, @Query('to') to?: string) {
    return this.reports.forOrganization(org, from, to);
  }

  /** Pickup orders: the goods are waiting at the pickup location. */
  @Post(':orderId/ready-for-pickup')
  ready(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @OrderId() orderId: string) {
    return this.orders.readyForPickup(org, user.userId, orderId);
  }

  /** The buyer collected a pickup order. */
  @Post(':orderId/collected')
  collected(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @OrderId() orderId: string) {
    return this.orders.collected(org, user.userId, orderId);
  }

  /** No-show: not collected within the pickup hold time. */
  @Post(':orderId/uncollected')
  uncollected(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @OrderId() orderId: string, @Body() dto: ReasonDto) {
    return this.orders.uncollected(org, user.userId, orderId, dto.reason?.trim() || null);
  }

  @Post(':orderId/delivery-failed')
  deliveryFailed(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @OrderId() orderId: string, @Body() dto: ReasonDto) {
    return this.orders.deliveryFailed(org, user.userId, orderId, dto.reason?.trim() || null);
  }

  /** Retry after a failed delivery or a missed pickup. */
  @Post(':orderId/retry')
  retry(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @OrderId() orderId: string) {
    return this.orders.retry(org, user.userId, orderId);
  }

  /** Which of your locations fulfils the order. */
  @Put(':orderId/fulfillment-location')
  assign(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @OrderId() orderId: string, @Body() dto: FulfillmentLocationDto) {
    return this.orders.assignFulfillment(org, user.userId, orderId, dto);
  }

  @Get()
  list(@ActingOrg() org: ActingOrganization, @Query() query: ListOrdersQueryDto) {
    return this.orders.list(org, 'supplier', query);
  }

  @Get(':orderId')
  get(@ActingOrg() org: ActingOrganization, @OrderId() orderId: string) {
    return this.orders.get(org, 'supplier', orderId);
  }

  @Post(':orderId/confirm')
  confirm(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @OrderId() orderId: string) {
    return this.orders.confirm(org, user.userId, orderId);
  }

  /** Decline an order that hasn't been confirmed yet. */
  @Post(':orderId/cancel')
  decline(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @OrderId() orderId: string, @Body() dto: ReasonDto) {
    return this.orders.cancel(org, 'supplier', user.userId, orderId, dto.reason?.trim() || null);
  }
}

/** For Logistics, Finance and Disputes: order facts without going through either party. */
@Controller('internal/orders')
export class InternalOrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly reports: ReportsService,
  ) {}

  @ApiExcludeEndpoint()
  @Internal('analytics')
  @Get('reports/locations/:organizationId')
  locationReport(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.reports.build(organizationId, null, from, to);
  }

  @ApiExcludeEndpoint()
  @Internal('logistics', 'finance', 'dispute', 'quality', 'notification')
  @Get(':orderId')
  get(@OrderId() orderId: string) {
    return this.orders.internalGet(orderId);
  }
}

/** Returns, from either side: ?side=buyer (default) or ?side=supplier. */
@ApiTags('returns')
@ApiBearerAuth()
@ActsForOrganization()
@RequiresModule('returns')
@Controller('returns')
export class ReturnsController {
  constructor(private readonly returns: ReturnsService) {}

  @Get()
  list(@ActingOrg() org: ActingOrganization, @Query() query: ListReturnsQueryDto, @Query('side') side?: string) {
    return this.returns.list(org, side === 'supplier' ? 'supplier' : 'buyer', query);
  }

  @Get(':returnId')
  get(@ActingOrg() org: ActingOrganization, @ReturnId() id: string, @Query('side') side?: string) {
    return this.returns.get(org, side === 'supplier' ? 'supplier' : 'buyer', id);
  }

  /** Supplier: approve or reject. */
  @Post(':returnId/decision')
  @HttpCode(200)
  decide(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @ReturnId() id: string, @Body() dto: ReturnDecisionDto) {
    return this.returns.decide(org, user.userId, id, dto);
  }

  /** Supplier: the goods are back. */
  @Post(':returnId/receive')
  @HttpCode(200)
  receive(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @ReturnId() id: string) {
    return this.returns.receive(org, user.userId, id);
  }

  /** Buyer: withdraw the request. */
  @Post(':returnId/cancel')
  @HttpCode(200)
  cancel(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @ReturnId() id: string) {
    return this.returns.cancel(org, user.userId, id);
  }
}

/** Buyer side of promotions: browse offers and see savings (no promotions module needed). */
@ApiTags('promotions')
@Controller('promotions')
export class OffersController {
  constructor(private readonly promotions: PromotionsService) {}

  /** Current advertised offers, for the marketplace and supplier pages. */
  @Public()
  @Get('offers')
  offers(@Query() query: OffersQueryDto) {
    return this.promotions.offers(query);
  }

  @ApiBearerAuth()
  @ActsForOrganization()
  @Get('savings')
  savings(@ActingOrg() org: ActingOrganization, @Query() query: PaginationQueryDto) {
    return this.promotions.savings(org, query);
  }
}

@ApiTags('promotions')
@ApiBearerAuth()
@ActsForOrganization()
@RequiresModule('promotions')
@Controller('promotions')
export class PromotionsController {
  constructor(private readonly promotions: PromotionsService) {}

  @Get('performance')
  performance(@ActingOrg() org: ActingOrganization) {
    return this.promotions.performance(org);
  }

  @Get()
  list(@ActingOrg() org: ActingOrganization, @Query() query: PaginationQueryDto) {
    return this.promotions.list(org, query);
  }

  @Post()
  create(@ActingOrg() org: ActingOrganization, @Body() dto: PromotionDto) {
    return this.promotions.create(org, dto);
  }

  @Put(':promotionId')
  update(@ActingOrg() org: ActingOrganization, @Param('promotionId', new ParseUUIDPipe()) id: string, @Body() dto: PromotionDto) {
    return this.promotions.update(org, id, dto);
  }

  /** Buyer: the discount a coupon (or automatic offer) would give on a subtotal. */
  @Post('check')
  @HttpCode(200)
  check(@ActingOrg() org: ActingOrganization, @Body() dto: CouponCheckDto) {
    return this.promotions.check(org, dto);
  }
}

@ApiTags('cancellation-policies')
@ApiBearerAuth()
@Controller('cancellation-policies')
export class PoliciesController {
  constructor(private readonly policies: PoliciesService) {}

  /** A supplier's current terms, for buyers to read before ordering. */
  @Get('current/:organizationId')
  current(@Param('organizationId', new ParseUUIDPipe()) organizationId: string) {
    return this.policies.current(organizationId);
  }

  /** Your organization's versions, newest first. */
  @ActsForOrganization()
  @Get()
  history(@ActingOrg() org: ActingOrganization) {
    return this.policies.history(org);
  }

  /** Publishes a new version; existing orders keep theirs. */
  @ActsForOrganization()
  @Post()
  publish(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Body() dto: CancellationPolicyDto) {
    return this.policies.publish(org, user.userId, dto);
  }
}
