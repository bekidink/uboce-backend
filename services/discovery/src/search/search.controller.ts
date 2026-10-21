import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '@uboce/common';

import { SearchProductsQueryDto, SearchSuppliersQueryDto } from './search.dto.js';
import { SearchService } from './search.service.js';

/** Public search: only published products and active organizations are ever visible here. */
@ApiTags('discovery')
@Public()
@Controller('discovery')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get('products')
  products(@Query() query: SearchProductsQueryDto) {
    return this.search.searchProducts(query);
  }

  @Get('suppliers')
  suppliers(@Query() query: SearchSuppliersQueryDto) {
    return this.search.searchSuppliers(query);
  }

  /** Index freshness. */
  @Get('status')
  status() {
    return this.search.status();
  }
}
