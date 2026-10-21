import { Module } from '@nestjs/common';
import { coreModules, OutboxRelayHost } from '@uboce/common';

import { env, SERVICE_NAME } from './config.js';
import { PrismaModule, PrismaService } from './prisma.service.js';
import { ProductionController, ProductionPostingRetryJob } from './production/production.controller.js';
import { ProductionService } from './production/production.service.js';

@Module({
  imports: coreModules({ serviceName: SERVICE_NAME, env, prismaService: PrismaService, prismaModule: PrismaModule }),
  controllers: [ProductionController],
  providers: [ProductionService, ProductionPostingRetryJob, OutboxRelayHost(PrismaService)],
})
export class AppModule {}
