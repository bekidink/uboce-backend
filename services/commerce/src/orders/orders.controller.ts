import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { type ActingOrganization, ActingOrg, ActsForOrganization, type AuthUser, badRequest, CurrentUser } from '@uboce/common';
import type { Response } from 'express';

import { CreateDirectOrderDto, ListOrdersQueryDto, ReasonDto } from './orders.dto.js';
import { OrdersService } from './orders.service.js';

const OrderId = () => Param('orderId', new ParseUUIDPipe());
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;

/** The buyer's side of orders. */
@ApiTags('purchase-orders')
@ApiBearerAuth()
@ActsForOrganization()
@Controller('purchase-orders')
export class PurchaseOrdersController {
  constructor(private readonly orders: OrdersService) {}

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
}

/** The supplier's side of the same orders. */
@ApiTags('sales-orders')
@ApiBearerAuth()
@ActsForOrganization()
@Controller('sales-orders')
export class SalesOrdersController {
  constructor(private readonly orders: OrdersService) {}

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
