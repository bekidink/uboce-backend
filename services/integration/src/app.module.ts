import { Module } from '@nestjs/common';
import { coreModules, OutboxRelayHost } from '@uboce/common';

import { CallbacksController } from './callbacks/callbacks.controller.js';
import { CallbacksService } from './callbacks/callbacks.service.js';
import { env, SERVICE_NAME } from './config.js';
import { PrismaModule, PrismaService } from './prisma.service.js';

@Module({
  imports: coreModules({ serviceName: SERVICE_NAME, env, prismaService: PrismaService, prismaModule: PrismaModule }),
  controllers: [CallbacksController],
  providers: [CallbacksService, OutboxRelayHost(PrismaService)],
})
export class AppModule {}
