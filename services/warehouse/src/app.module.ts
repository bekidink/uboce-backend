import { Module } from '@nestjs/common';
import { coreModules, OutboxRelayHost } from '@uboce/common';

import { env, SERVICE_NAME } from './config.js';
import { PrismaModule, PrismaService } from './prisma.service.js';
import { InternalWarehouseController, WarehouseController } from './warehouse/warehouse.controller.js';
import { TransferRequestsController, TransferRequestsService } from './warehouse/transfer-requests.js';
import { WarehouseEvents } from './warehouse/warehouse-events.js';
import { WarehouseService } from './warehouse/warehouse.service.js';

@Module({
  imports: coreModules({ serviceName: SERVICE_NAME, env, prismaService: PrismaService, prismaModule: PrismaModule }),
  controllers: [TransferRequestsController, WarehouseController, InternalWarehouseController],
  providers: [TransferRequestsService, WarehouseService, WarehouseEvents, OutboxRelayHost(PrismaService)],
})
export class AppModule {}
