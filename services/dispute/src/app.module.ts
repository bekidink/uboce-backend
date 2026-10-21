import { Module } from '@nestjs/common';
import { coreModules, OutboxRelayHost } from '@uboce/common';

import { env, SERVICE_NAME } from './config.js';
import { DisputeReviewController, DisputesController, PerformanceController } from './disputes/disputes.controller.js';
import { DisputesService } from './disputes/disputes.service.js';
import { PerformanceEvents, PerformanceService } from './performance/performance.js';
import { PrismaModule, PrismaService } from './prisma.service.js';

@Module({
  imports: coreModules({ serviceName: SERVICE_NAME, env, prismaService: PrismaService, prismaModule: PrismaModule }),
  controllers: [DisputesController, DisputeReviewController, PerformanceController],
  providers: [DisputesService, PerformanceService, PerformanceEvents, OutboxRelayHost(PrismaService)],
})
export class AppModule {}
