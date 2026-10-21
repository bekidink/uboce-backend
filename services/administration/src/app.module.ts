import { Module } from '@nestjs/common';
import { coreModules, OutboxRelayHost } from '@uboce/common';

import { AdminController, InternalPlatformRolesController } from './admin/admin.controller.js';
import { AdminService } from './admin/admin.service.js';
import { env, SERVICE_NAME } from './config.js';
import { PrismaModule, PrismaService } from './prisma.service.js';

@Module({
  imports: coreModules({ serviceName: SERVICE_NAME, env, prismaService: PrismaService, prismaModule: PrismaModule }),
  controllers: [AdminController, InternalPlatformRolesController],
  providers: [AdminService, OutboxRelayHost(PrismaService)],
})
export class AppModule {}
