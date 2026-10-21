import { Module } from '@nestjs/common';
import { coreModules, OutboxRelayHost } from '@uboce/common';

import { ExpiryJob, InternalKycController, KycController, KycReviewController } from './cases/cases.controller.js';
import { CasesService } from './cases/cases.service.js';
import { env, SERVICE_NAME } from './config.js';
import { PrismaModule, PrismaService } from './prisma.service.js';

@Module({
  imports: coreModules({ serviceName: SERVICE_NAME, env, prismaService: PrismaService, prismaModule: PrismaModule }),
  controllers: [KycController, KycReviewController, InternalKycController],
  providers: [CasesService, ExpiryJob, OutboxRelayHost(PrismaService)],
})
export class AppModule {}
