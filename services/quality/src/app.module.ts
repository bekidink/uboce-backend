import { Module } from '@nestjs/common';
import { coreModules, OutboxRelayHost } from '@uboce/common';

import { env, SERVICE_NAME } from './config.js';
import { PrismaModule, PrismaService } from './prisma.service.js';
import { QualityController } from './quality/quality.controller.js';
import { QualityEvents } from './quality/quality-events.js';
import { QualityService } from './quality/quality.service.js';

@Module({
  imports: coreModules({ serviceName: SERVICE_NAME, env, prismaService: PrismaService, prismaModule: PrismaModule }),
  controllers: [QualityController],
  providers: [QualityService, QualityEvents, OutboxRelayHost(PrismaService)],
})
export class AppModule {}
