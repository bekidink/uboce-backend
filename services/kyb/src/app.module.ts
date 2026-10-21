import { Module } from '@nestjs/common';
import { coreModules, OutboxRelayHost } from '@uboce/common';

import { ExpiryJob, InternalKybController, KybController, KybReviewController } from './cases/cases.controller.js';
import { CasesService } from './cases/cases.service.js';
import { env, SERVICE_NAME } from './config.js';
import { PrismaModule, PrismaService } from './prisma.service.js';

@Module({
  imports: coreModules({ serviceName: SERVICE_NAME, env, prismaService: PrismaService, prismaModule: PrismaModule }),
  controllers: [KybController, KybReviewController, InternalKybController],
  providers: [CasesService, ExpiryJob, OutboxRelayHost(PrismaService)],
})
export class AppModule {}
