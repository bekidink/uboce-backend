import { Module } from '@nestjs/common';
import { coreModules } from '@uboce/common';

import { env, SERVICE_NAME } from './config.js';
import { AnalyticsController, AnalyticsProjector } from './metrics/analytics.js';
import { PrismaModule, PrismaService } from './prisma.service.js';

@Module({
  imports: coreModules({ serviceName: SERVICE_NAME, env, prismaService: PrismaService, prismaModule: PrismaModule }),
  controllers: [AnalyticsController],
  providers: [AnalyticsProjector],
})
export class AppModule {}
