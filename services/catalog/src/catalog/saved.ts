import { Controller, Delete, Get, HttpCode, Injectable, Param, ParseUUIDPipe, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { type ActingOrganization, ActingOrg, ActsForOrganization, type AuthUser, badRequest, CurrentUser, notFound, PaginationQueryDto, skipTake, toPage } from '@uboce/common';

import { PrismaService } from '../prisma.service.js';

const MAX_SAVED = 500;

/** Wishlist: any member of a buying organization (or a single customer) can save products for later. */
@Injectable()
export class SavedProductsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(org: ActingOrganization, query: PaginationQueryDto) {
    const where = { organizationId: org.organization.id };
    const [rows, total] = await Promise.all([
      this.prisma.savedProduct.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: {
          product: {
            select: {
              id: true,
              name: true,
              status: true,
              organizationId: true,
              unitOfMeasure: true,
              media: { orderBy: { position: 'asc' }, take: 1, select: { documentId: true } },
              variants: { where: { isActive: true }, select: { id: true, name: true, price: true, currency: true } },
            },
          },
        },
        ...skipTake(query),
      }),
      this.prisma.savedProduct.count({ where }),
    ]);
    // Products taken off sale stay listed (so buyers see what happened) but are marked unavailable.
    const items = rows.map(({ product: { media, variants, ...p }, createdAt }) => ({
      ...p,
      savedAt: createdAt,
      available: p.status === 'published',
      imageDocumentId: media[0]?.documentId ?? null,
      fromPrice: variants.length ? variants.reduce((min, v) => (v.price.lt(min.price) ? v : min)).price.toFixed(2) : null,
      currency: variants[0]?.currency ?? null,
    }));
    return toPage(items, total, query);
  }

  async save(org: ActingOrganization, userId: string, productId: string) {
    const product = await this.prisma.product.findFirst({ where: { id: productId, status: 'published' }, select: { id: true } });
    if (!product) throw notFound('Product');
    if ((await this.prisma.savedProduct.count({ where: { organizationId: org.organization.id } })) >= MAX_SAVED) {
      throw badRequest('too_many_saved', `Save at most ${MAX_SAVED} products`);
    }
    await this.prisma.savedProduct.upsert({
      where: { organizationId_productId: { organizationId: org.organization.id, productId } },
      create: { organizationId: org.organization.id, productId, savedByUserId: userId },
      update: {},
    });
    return { productId, saved: true };
  }

  async remove(org: ActingOrganization, productId: string) {
    await this.prisma.savedProduct.deleteMany({ where: { organizationId: org.organization.id, productId } });
  }

  /** Which of these products the organization has saved (for heart icons on result lists). */
  async which(org: ActingOrganization, productIds: string[]) {
    const rows = await this.prisma.savedProduct.findMany({ where: { organizationId: org.organization.id, productId: { in: productIds } }, select: { productId: true } });
    return { saved: rows.map((r) => r.productId) };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@ApiTags('catalog')
@ApiBearerAuth()
@ActsForOrganization()
@Controller('catalog/saved')
export class SavedProductsController {
  constructor(private readonly saved: SavedProductsService) {}

  @Get()
  list(@ActingOrg() org: ActingOrganization, @Query() query: PaginationQueryDto) {
    return this.saved.list(org, query);
  }

  /** ?productIds=a,b,c → which of them are saved. */
  @Get('status')
  status(@ActingOrg() org: ActingOrganization, @Query('productIds') productIds = '') {
    const ids = productIds.split(',').filter((id) => UUID.test(id)).slice(0, 100);
    return this.saved.which(org, ids);
  }

  @Put(':productId')
  save(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Param('productId', new ParseUUIDPipe()) productId: string) {
    return this.saved.save(org, user.userId, productId);
  }

  @Delete(':productId')
  @HttpCode(204)
  async remove(@ActingOrg() org: ActingOrganization, @Param('productId', new ParseUUIDPipe()) productId: string) {
    await this.saved.remove(org, productId);
  }
}
