import { Module } from '@nestjs/common';
import { coreModules, OutboxRelayHost } from '@uboce/common';

import { env, SERVICE_NAME } from './config.js';
import { InternalController } from './internal/internal.controller.js';
import { InvitationsController } from './invitations/invitations.controller.js';
import { InvitationsService } from './invitations/invitations.service.js';
import { OrganizationsController } from './organizations/organizations.controller.js';
import { OrganizationsService } from './organizations/organizations.service.js';
import { PrismaModule, PrismaService } from './prisma.service.js';

@Module({
  imports: coreModules({ serviceName: SERVICE_NAME, env, prismaService: PrismaService, prismaModule: PrismaModule }),
  controllers: [OrganizationsController, InvitationsController, InternalController],
  providers: [OrganizationsService, InvitationsService, OutboxRelayHost(PrismaService)],
})
export class AppModule {}
