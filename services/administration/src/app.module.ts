import { Module } from '@nestjs/common';
import { coreModules, OutboxRelayHost } from '@uboce/common';

import { AdminController, InternalEntitlementsController, InternalPlatformRolesController } from './admin/admin.controller.js';
import { AdminService } from './admin/admin.service.js';
import { env, SERVICE_NAME } from './config.js';
import { SchedulerController } from './scheduler/scheduler.controller.js';
import { SchedulerService } from './scheduler/scheduler.service.js';
import { PrismaModule, PrismaService } from './prisma.service.js';

@Module({
  imports: coreModules({ serviceName: SERVICE_NAME, env, prismaService: PrismaService, prismaModule: PrismaModule }),
  controllers: [AdminController, InternalPlatformRolesController, InternalEntitlementsController, SchedulerController],
  providers: [AdminService, SchedulerService, OutboxRelayHost(PrismaService)],
})
export class AppModule {}
