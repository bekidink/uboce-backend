import { Module } from '@nestjs/common';
import { coreModules, OutboxRelayHost } from '@uboce/common';

import { env, SERVICE_NAME } from './config.js';
import { PrismaModule, PrismaService } from './prisma.service.js';
import { AssistantController, ProcurementAssistant } from './assistant.js';
import { QuotationsController, RfqsController } from './procurement.controller.js';
import { ProcurementService } from './procurement.service.js';

@Module({
  imports: coreModules({ serviceName: SERVICE_NAME, env, prismaService: PrismaService, prismaModule: PrismaModule }),
  controllers: [AssistantController, RfqsController, QuotationsController],
  providers: [ProcurementService, ProcurementAssistant, OutboxRelayHost(PrismaService)],
})
export class AppModule {}
