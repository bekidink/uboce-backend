import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { type ActingOrganization, ActingOrg, ActsForOrganization, type AuthUser, CurrentUser, Public } from '@uboce/common';

import { CreateProductDto, ListProductsQueryDto, UpdateProductDto, UpdateVariantDto, VariantDto } from './catalog.dto.js';
import { CatalogService } from './catalog.service.js';

const ProductId = () => Param('productId', new ParseUUIDPipe());

@ApiTags('catalog')
@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Public()
  @Get('categories')
  categories() {
    return this.catalog.listCategories();
  }

  /** A published product, as any buyer sees it. */
  @ApiBearerAuth()
  @Get('published/:productId')
  published(@ProductId() productId: string) {
    return this.catalog.getPublished(productId);
  }

  // ---- Managing your organization's catalog ---------------------------------

  @ApiBearerAuth()
  @ActsForOrganization()
  @Post('products')
  create(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Body() dto: CreateProductDto) {
    return this.catalog.create(org, user.userId, dto);
  }

  @ApiBearerAuth()
  @ActsForOrganization()
  @Get('products')
  list(@ActingOrg() org: ActingOrganization, @Query() query: ListProductsQueryDto) {
    return this.catalog.list(org, query);
  }

  @ApiBearerAuth()
  @ActsForOrganization()
  @Get('products/:productId')
  get(@ActingOrg() org: ActingOrganization, @ProductId() productId: string) {
    return this.catalog.get(org, productId);
  }

  @ApiBearerAuth()
  @ActsForOrganization()
  @Patch('products/:productId')
  update(@ActingOrg() org: ActingOrganization, @ProductId() productId: string, @Body() dto: UpdateProductDto) {
    return this.catalog.update(org, productId, dto);
  }

  @ApiBearerAuth()
  @ActsForOrganization()
  @Post('products/:productId/variants')
  addVariant(@ActingOrg() org: ActingOrganization, @ProductId() productId: string, @Body() dto: VariantDto) {
    return this.catalog.addVariant(org, productId, dto);
  }

  @ApiBearerAuth()
  @ActsForOrganization()
  @Patch('products/:productId/variants/:variantId')
  updateVariant(
    @ActingOrg() org: ActingOrganization,
    @ProductId() productId: string,
    @Param('variantId', new ParseUUIDPipe()) variantId: string,
    @Body() dto: UpdateVariantDto,
  ) {
    return this.catalog.updateVariant(org, productId, variantId, dto);
  }

  @ApiBearerAuth()
  @ActsForOrganization()
  @Post('products/:productId/publish')
  publish(@ActingOrg() org: ActingOrganization, @ProductId() productId: string) {
    return this.catalog.publish(org, productId);
  }

  @ApiBearerAuth()
  @ActsForOrganization()
  @Post('products/:productId/archive')
  archive(@ActingOrg() org: ActingOrganization, @ProductId() productId: string) {
    return this.catalog.archive(org, productId);
  }
}
