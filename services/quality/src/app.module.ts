import { Module } from '@nestjs/common';
import { coreModules, OutboxRelayHost } from '@uboce/common';

import { env, SERVICE_NAME } from './config.js';
import { PrismaModule, PrismaService } from './prisma.service.js';
import { QualityController } from './quality/quality.controller.js';
import { QualityEvents } from './quality/quality-events.js';
import { QualityService } from './quality/quality.service.js';
import { ModerationController, PublicTrustController, TrustController } from './quality/trust.controller.js';
import { TrustService } from './quality/trust.service.js';

@Module({
  imports: coreModules({ serviceName: SERVICE_NAME, env, prismaService: PrismaService, prismaModule: PrismaModule }),
  controllers: [PublicTrustController, ModerationController, TrustController, QualityController],
  providers: [QualityService, TrustService, QualityEvents, OutboxRelayHost(PrismaService)],
})
export class AppModule {}
