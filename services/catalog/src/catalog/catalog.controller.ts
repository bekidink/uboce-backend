import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { type ActingOrganization, ActingOrg, ActsForOrganization, type AuthUser, CurrentUser, Internal, PaginationQueryDto, Public } from '@uboce/common';

import {
  CreateProductDto,
  ListProductsQueryDto,
  PriceCheckDto,
  PriceListDto,
  PriceTiersDto,
  ProductMediaDto,
  ProductOptionsDto,
  QuoteDto,
  UpdateProductDto,
  UpdateVariantDto,
  VariantDto,
} from './catalog.dto.js';
import { CatalogService } from './catalog.service.js';
import { PricingService } from './pricing.service.js';

const ProductId = () => Param('productId', new ParseUUIDPipe());

@ApiTags('catalog')
@Controller('catalog')
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly pricing: PricingService,
  ) {}

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

  /** AI-suggested description from the product's name, category and attributes (review before saving). */
  @ApiBearerAuth()
  @ActsForOrganization()
  @Post('products/:productId/assist/description')
  @HttpCode(200)
  describe(@ActingOrg() org: ActingOrganization, @ProductId() productId: string) {
    return this.catalog.suggestDescription(org, productId);
  }

  /** Images in display order; the first is the primary one. */
  @ApiBearerAuth()
  @ActsForOrganization()
  @Put('products/:productId/media')
  setMedia(@ActingOrg() org: ActingOrganization, @ProductId() productId: string, @Body() dto: ProductMediaDto) {
    return this.catalog.setMedia(org, productId, dto);
  }

  /** Add-ons and choices (replaces all groups). */
  @ApiBearerAuth()
  @ActsForOrganization()
  @Put('products/:productId/options')
  setOptions(@ActingOrg() org: ActingOrganization, @ProductId() productId: string, @Body() dto: ProductOptionsDto) {
    return this.catalog.setOptions(org, productId, dto);
  }

  /** Bulk prices for a variant (replaces all tiers). */
  @ApiBearerAuth()
  @ActsForOrganization()
  @Put('products/:productId/variants/:variantId/price-tiers')
  setTiers(
    @ActingOrg() org: ActingOrganization,
    @ProductId() productId: string,
    @Param('variantId', new ParseUUIDPipe()) variantId: string,
    @Body() dto: PriceTiersDto,
  ) {
    return this.pricing.setTiers(org, productId, variantId, dto);
  }

  @ApiBearerAuth()
  @ActsForOrganization()
  @Get('price-lists')
  priceLists(@ActingOrg() org: ActingOrganization, @Query() query: PaginationQueryDto) {
    return this.pricing.listPriceLists(org, query);
  }

  @ApiBearerAuth()
  @ActsForOrganization()
  @Post('price-lists')
  createPriceList(@ActingOrg() org: ActingOrganization, @Body() dto: PriceListDto) {
    return this.pricing.createPriceList(org, dto);
  }

  @ApiBearerAuth()
  @ActsForOrganization()
  @Put('price-lists/:priceListId')
  updatePriceList(@ActingOrg() org: ActingOrganization, @Param('priceListId', new ParseUUIDPipe()) id: string, @Body() dto: PriceListDto) {
    return this.pricing.updatePriceList(org, id, dto);
  }

  /** What the acting (buyer) organization would pay: tiers, its price lists and options applied. */
  @ApiBearerAuth()
  @ActsForOrganization()
  @Post('price-check')
  @HttpCode(200)
  priceCheck(@ActingOrg() org: ActingOrganization, @Body() dto: PriceCheckDto) {
    return this.pricing.quote({ ...dto, buyerOrganizationId: org.organization.id });
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

@Controller('internal/catalog')
export class InternalCatalogController {
  constructor(private readonly pricing: PricingService) {}

  @ApiExcludeEndpoint()
  @Internal('commerce', 'procurement')
  @Post('quote')
  @HttpCode(200)
  quote(@Body() dto: QuoteDto) {
    return this.pricing.quote(dto);
  }
}
