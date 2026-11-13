import { Body, Controller, Delete, Get, Headers, HttpCode, Injectable, Param, ParseUUIDPipe, Post, Put, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import {
  type ActingOrganization,
  ActingOrg,
  ActsForOrganization,
  type AuthUser,
  badRequest,
  CatalogClient,
  CurrentUser,
  IsCurrency,
  notFound,
  requireRole,
} from '@uboce/common';
import { ArrayMaxSize, IsEnum, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';
import type { Response } from 'express';

import { Prisma } from '../generated/prisma/client.js';
import { FulfillmentMethod } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma.service.js';
import { BUYER_ROLES, OrdersService, quoteFailure } from './orders.service.js';

const { Decimal } = Prisma;
const MAX_ITEMS = 100;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;

export class CartItemDto {
  /** The supplier selling this variant (as shown on the product). */
  @IsUUID()
  supplierOrganizationId: string;

  @IsCurrency()
  currency: string;

  @IsUUID()
  variantId: string;

  @IsOptional()
  @IsUUID('all', { each: true })
  @ArrayMaxSize(30)
  optionIds?: string[];

  /** The new quantity; "0" removes the line. */
  @Matches(/^\d{1,10}(\.\d{1,4})?$/)
  quantity: string;
}

export class CartCheckoutDto {
  /** Checks out this supplier's items (one order per supplier). */
  @IsUUID()
  supplierOrganizationId: string;

  @IsOptional()
  @IsString()
  @Length(0, 300)
  deliveryLocation?: string;

  @ApiPropertyOptional({ enum: FulfillmentMethod, default: FulfillmentMethod.delivery })
  @IsOptional()
  @IsEnum(FulfillmentMethod)
  fulfillmentMethod?: FulfillmentMethod;

  @IsOptional()
  @IsUUID()
  fulfillmentBranchId?: string;

  @IsOptional()
  @Matches(/^[A-Za-z0-9_-]{3,40}$/)
  couponCode?: string;
}

@Injectable()
export class CartService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogClient,
    private readonly orders: OrdersService,
  ) {}

  /** The cart grouped by supplier, priced now from the catalog (tiers, price lists, options). */
  async get(org: ActingOrganization) {
    requireRole(org, BUYER_ROLES, 'use the cart');
    const items = await this.prisma.cartItem.findMany({ where: { buyerOrganizationId: org.organization.id }, orderBy: { createdAt: 'asc' } });
    const groups = new Map<string, typeof items>();
    for (const item of items) {
      const key = `${item.supplierOrganizationId}:${item.currency}`;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    const suppliers = [];
    for (const lines of groups.values()) {
      const first = lines[0]!;
      let priced: Awaited<ReturnType<CatalogClient['quote']>> | null = null;
      let problem: string | null = null;
      try {
        priced = await this.catalog.quote({
          supplierOrganizationId: first.supplierOrganizationId,
          buyerOrganizationId: org.organization.id,
          currency: first.currency,
          lines: lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity.toString(), optionIds: l.optionIds })),
        });
      } catch (error) {
        // A product went off sale or changed: show the lines, flag the group, keep the cart.
        problem = (quoteFailure(error) as Error).message ?? 'Some items are no longer available';
      }
      const rows = lines.map((l, i) => {
        const q = priced?.lines[i];
        return {
          id: l.id,
          variantId: l.variantId,
          optionIds: l.optionIds,
          quantity: l.quantity.toString(),
          description: q?.description ?? null,
          unitPrice: q?.unitPrice ?? null,
          lineTotal: q ? new Decimal(q.unitPrice).times(l.quantity).toFixed(2) : null,
          imageDocumentId: q?.snapshot.imageDocumentId ?? null,
        };
      });
      const subtotal = rows.reduce((sum, r) => (r.lineTotal ? sum.plus(r.lineTotal) : sum), new Decimal(0));
      suppliers.push({ supplierOrganizationId: first.supplierOrganizationId, currency: first.currency, subtotal: subtotal.toFixed(2), problem, items: rows });
    }
    return { suppliers, itemCount: items.length };
  }

  /** Adds or changes a line (quantity 0 removes it). The catalog must accept it for this supplier. */
  async set(org: ActingOrganization, userId: string, dto: CartItemDto) {
    requireRole(org, BUYER_ROLES, 'use the cart');
    if (dto.supplierOrganizationId === org.organization.id) throw badRequest('self_order', 'You cannot order from your own organization');
    const optionIds = [...new Set(dto.optionIds ?? [])].sort();
    const optionsKey = optionIds.join(',');
    const where = { buyerOrganizationId_variantId_optionsKey: { buyerOrganizationId: org.organization.id, variantId: dto.variantId, optionsKey } };
    const quantity = new Decimal(dto.quantity);
    if (quantity.isZero()) {
      await this.prisma.cartItem.deleteMany({ where: where.buyerOrganizationId_variantId_optionsKey });
      return this.get(org);
    }
    // Validates the variant, its options, minimum order quantity and availability now, not at checkout.
    await this.catalog
      .quote({ supplierOrganizationId: dto.supplierOrganizationId, buyerOrganizationId: org.organization.id, currency: dto.currency, lines: [{ variantId: dto.variantId, quantity: dto.quantity, optionIds }] })
      .catch((error: unknown) => {
        throw quoteFailure(error);
      });
    const count = await this.prisma.cartItem.count({ where: { buyerOrganizationId: org.organization.id } });
    const existing = await this.prisma.cartItem.findUnique({ where });
    if (!existing && count >= MAX_ITEMS) throw badRequest('cart_full', `A cart holds at most ${MAX_ITEMS} lines`);
    await this.prisma.cartItem.upsert({
      where,
      create: { buyerOrganizationId: org.organization.id, supplierOrganizationId: dto.supplierOrganizationId, currency: dto.currency, variantId: dto.variantId, optionIds, optionsKey, quantity, addedByUserId: userId },
      update: { quantity, supplierOrganizationId: dto.supplierOrganizationId, currency: dto.currency },
    });
    return this.get(org);
  }

  async remove(org: ActingOrganization, itemId: string) {
    requireRole(org, BUYER_ROLES, 'use the cart');
    const { count } = await this.prisma.cartItem.deleteMany({ where: { id: itemId, buyerOrganizationId: org.organization.id } });
    if (!count) throw notFound('Cart item');
  }

  async clear(org: ActingOrganization) {
    requireRole(org, BUYER_ROLES, 'use the cart');
    await this.prisma.cartItem.deleteMany({ where: { buyerOrganizationId: org.organization.id } });
  }

  /**
   * Places one supplier's items as a direct order (priced again by the catalog) and removes them
   * from the cart. Retrying with the same Idempotency-Key returns the same order.
   */
  async checkout(org: ActingOrganization, userId: string, idempotencyKey: string, dto: CartCheckoutDto) {
    const items = await this.prisma.cartItem.findMany({ where: { buyerOrganizationId: org.organization.id, supplierOrganizationId: dto.supplierOrganizationId }, orderBy: { createdAt: 'asc' } });
    if (!items.length) {
      // A retry after a successful checkout finds the cart empty: the order replays by its key.
      const replay = await this.prisma.order.findFirst({ where: { buyerOrganizationId: org.organization.id, idempotencyKey } });
      if (replay) return { order: await this.orders.get(org, 'buyer', replay.id), replayed: true };
      throw badRequest('cart_empty', 'There is nothing from this supplier in your cart');
    }
    const currencies = new Set(items.map((i) => i.currency));
    if (currencies.size > 1) throw badRequest('mixed_currencies', 'Items from one supplier must be in one currency; remove the others first');
    const result = await this.orders.createDirect(org, userId, idempotencyKey, {
      supplierOrganizationId: dto.supplierOrganizationId,
      currency: items[0]!.currency,
      deliveryLocation: dto.deliveryLocation,
      fulfillmentMethod: dto.fulfillmentMethod,
      fulfillmentBranchId: dto.fulfillmentBranchId,
      couponCode: dto.couponCode,
      lines: items.map((i) => ({ variantId: i.variantId, optionIds: i.optionIds, quantity: i.quantity.toString() })),
    });
    await this.prisma.cartItem.deleteMany({ where: { id: { in: items.map((i) => i.id) } } });
    return result;
  }

  /** "Order again": puts a past order's catalog lines back in the cart at today's prices. */
  async reorder(org: ActingOrganization, userId: string, orderId: string) {
    const order = await this.orders.owned(org, 'buyer', orderId);
    const lines = order.lines.filter((l) => l.variantId);
    if (!lines.length) throw badRequest('nothing_to_reorder', 'This order has no catalog products to order again');
    const skipped: string[] = [];
    for (const line of lines) {
      const snapshot = (line.snapshot ?? null) as { options?: { optionId: string }[] } | null;
      try {
        await this.set(org, userId, {
          supplierOrganizationId: order.supplierOrganizationId,
          currency: order.currency,
          variantId: line.variantId!,
          optionIds: snapshot?.options?.map((o) => o.optionId) ?? [],
          quantity: line.quantity.toString(),
        });
      } catch {
        skipped.push(line.description);
      }
    }
    return { cart: await this.get(org), skipped };
  }
}

@ApiTags('cart')
@ApiBearerAuth()
@ActsForOrganization()
@Controller('cart')
export class CartController {
  constructor(private readonly cart: CartService) {}

  @Get()
  get(@ActingOrg() org: ActingOrganization) {
    return this.cart.get(org);
  }

  /** Add a product, or change its quantity ("0" removes it). */
  @Put('items')
  set(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Body() dto: CartItemDto) {
    return this.cart.set(org, user.userId, dto);
  }

  @Delete('items/:itemId')
  @HttpCode(204)
  async remove(@ActingOrg() org: ActingOrganization, @Param('itemId', new ParseUUIDPipe()) itemId: string) {
    await this.cart.remove(org, itemId);
  }

  @Delete()
  @HttpCode(204)
  async clear(@ActingOrg() org: ActingOrganization) {
    await this.cart.clear(org);
  }

  /** Order one supplier's items. */
  @ApiHeader({ name: 'idempotency-key', required: true, description: '8–100 chars, unique per checkout' })
  @Post('checkout')
  async checkout(
    @ActingOrg() org: ActingOrganization,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: CartCheckoutDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!key || !IDEMPOTENCY_KEY.test(key)) throw badRequest('idempotency_key_required', 'Send an Idempotency-Key header (8–100 letters, digits, - or _)');
    const { order, replayed } = await this.cart.checkout(org, user.userId, key, dto);
    res.status(replayed ? 200 : 201);
    return order;
  }

  /** Put a past order's products back in the cart. */
  @Post('reorder/:orderId')
  @HttpCode(200)
  reorder(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Param('orderId', new ParseUUIDPipe()) orderId: string) {
    return this.cart.reorder(org, user.userId, orderId);
  }
}
