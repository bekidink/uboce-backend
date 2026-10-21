import { Module } from '@nestjs/common';
import { coreModules } from '@uboce/common';

import { env, SERVICE_NAME } from './config.js';
import { PrismaModule, PrismaService } from './prisma.service.js';
import { SearchIndexer } from './search/indexer.js';
import { SearchController } from './search/search.controller.js';
import { SearchService } from './search/search.service.js';

@Module({
  imports: coreModules({ serviceName: SERVICE_NAME, env, prismaService: PrismaService, prismaModule: PrismaModule }),
  controllers: [SearchController],
  providers: [SearchService, SearchIndexer],
})
export class AppModule {}
