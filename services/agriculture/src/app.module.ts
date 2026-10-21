import { Module } from '@nestjs/common';
import { coreModules, OutboxRelayHost } from '@uboce/common';

import { env, SERVICE_NAME } from './config.js';
import { AgricultureController, StockPostingRetryJob } from './lots/agriculture.controller.js';
import { AgricultureService } from './lots/agriculture.service.js';
import { PrismaModule, PrismaService } from './prisma.service.js';

@Module({
  imports: coreModules({ serviceName: SERVICE_NAME, env, prismaService: PrismaService, prismaModule: PrismaModule }),
  controllers: [AgricultureController],
  providers: [AgricultureService, StockPostingRetryJob, OutboxRelayHost(PrismaService)],
})
export class AppModule {}
