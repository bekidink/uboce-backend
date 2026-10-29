import { Module } from '@nestjs/common';
import { coreModules, OutboxRelayHost } from '@uboce/common';

import { CatalogController, InternalCatalogController } from './catalog/catalog.controller.js';
import { CatalogService } from './catalog/catalog.service.js';
import { CategoriesController, CategoriesService } from './catalog/categories.js';
import { CategorySeeder } from './catalog/categories.seed.js';
import { PricingService } from './catalog/pricing.service.js';
import { env, SERVICE_NAME } from './config.js';
import { PrismaModule, PrismaService } from './prisma.service.js';

@Module({
  imports: coreModules({ serviceName: SERVICE_NAME, env, prismaService: PrismaService, prismaModule: PrismaModule }),
  controllers: [CategoriesController, CatalogController, InternalCatalogController],
  providers: [CatalogService, CategoriesService, PricingService, CategorySeeder, OutboxRelayHost(PrismaService)],
})
export class AppModule {}
