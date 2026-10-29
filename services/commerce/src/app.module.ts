import { Module } from '@nestjs/common';
import { coreModules, OutboxRelayHost } from '@uboce/common';

import { env, SERVICE_NAME } from './config.js';
import { OrderEventHandlers } from './orders/order-events.js';
import { InternalOrdersController, PurchaseOrdersController, SalesOrdersController, OffersController, PoliciesController, PromotionsController, ReturnsController } from './orders/orders.controller.js';
import { OrdersService } from './orders/orders.service.js';
import { PoliciesService } from './orders/policies.service.js';
import { PromotionsService } from './orders/promotions.service.js';
import { ReportsService } from './orders/reports.service.js';
import { ReturnsService } from './orders/returns.service.js';
import { PrismaModule, PrismaService } from './prisma.service.js';

@Module({
  imports: coreModules({ serviceName: SERVICE_NAME, env, prismaService: PrismaService, prismaModule: PrismaModule }),
  controllers: [PurchaseOrdersController, SalesOrdersController, InternalOrdersController, ReturnsController, OffersController, PromotionsController, PoliciesController],
  providers: [OrdersService, ReportsService, PoliciesService, PromotionsService, ReturnsService, OrderEventHandlers, OutboxRelayHost(PrismaService)],
})
export class AppModule {}
