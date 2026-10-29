import { Module } from '@nestjs/common';
import { coreModules, OutboxRelayHost } from '@uboce/common';

import { env, SERVICE_NAME } from './config.js';
import { PrismaModule, PrismaService } from './prisma.service.js';
import { InternalTrackingController, ShipmentsController, FleetController, InternalShipmentsController } from './shipments/shipments.controller.js';
import { CarrierService } from './shipments/carrier.service.js';
import { FleetService } from './shipments/fleet.service.js';
import { ShipmentsService } from './shipments/shipments.service.js';

@Module({
  imports: coreModules({ serviceName: SERVICE_NAME, env, prismaService: PrismaService, prismaModule: PrismaModule }),
  controllers: [ShipmentsController, InternalTrackingController, FleetController, InternalShipmentsController],
  providers: [CarrierService, FleetService, ShipmentsService, OutboxRelayHost(PrismaService)],
})
export class AppModule {}
