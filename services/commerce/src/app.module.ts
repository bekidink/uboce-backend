import { Module } from '@nestjs/common';
import { coreModules, OutboxRelayHost } from '@uboce/common';

import { env, SERVICE_NAME } from './config.js';
import { OrderEventHandlers } from './orders/order-events.js';
import { InternalOrdersController, PurchaseOrdersController, SalesOrdersController } from './orders/orders.controller.js';
import { OrdersService } from './orders/orders.service.js';
import { PrismaModule, PrismaService } from './prisma.service.js';

@Module({
  imports: coreModules({ serviceName: SERVICE_NAME, env, prismaService: PrismaService, prismaModule: PrismaModule }),
  controllers: [PurchaseOrdersController, SalesOrdersController, InternalOrdersController],
  providers: [OrdersService, OrderEventHandlers, OutboxRelayHost(PrismaService)],
})
export class AppModule {}
