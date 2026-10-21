import { Module } from '@nestjs/common';
import { coreModules, OutboxRelayHost } from '@uboce/common';

import { env, SERVICE_NAME } from './config.js';
import { PrismaModule, PrismaService } from './prisma.service.js';
import { QuotationsController, RfqsController } from './procurement.controller.js';
import { ProcurementService } from './procurement.service.js';

@Module({
  imports: coreModules({ serviceName: SERVICE_NAME, env, prismaService: PrismaService, prismaModule: PrismaModule }),
  controllers: [RfqsController, QuotationsController],
  providers: [ProcurementService, OutboxRelayHost(PrismaService)],
})
export class AppModule {}
