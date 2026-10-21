import { Module } from '@nestjs/common';
import { coreModules, OutboxRelayHost } from '@uboce/common';

import { env, SERVICE_NAME } from './config.js';
import { InventoryEvents } from './ledger/inventory-events.js';
import { InternalInventoryController, InventoryController } from './ledger/ledger.controller.js';
import { LedgerService } from './ledger/ledger.service.js';
import { PrismaModule, PrismaService } from './prisma.service.js';

@Module({
  imports: coreModules({ serviceName: SERVICE_NAME, env, prismaService: PrismaService, prismaModule: PrismaModule }),
  controllers: [InventoryController, InternalInventoryController],
  providers: [LedgerService, InventoryEvents, OutboxRelayHost(PrismaService)],
})
export class AppModule {}
