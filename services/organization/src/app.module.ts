import { Module } from '@nestjs/common';
import { coreModules, OutboxRelayHost } from '@uboce/common';

import { env, SERVICE_NAME } from './config.js';
import { InternalController, InternalUsersController } from './internal/internal.controller.js';
import { InvitationsController } from './invitations/invitations.controller.js';
import { InvitationsService } from './invitations/invitations.service.js';
import { OrganizationsController } from './organizations/organizations.controller.js';
import { OrganizationsService } from './organizations/organizations.service.js';
import { AddressesController, AddressesService } from './organizations/addresses.js';
import { UserEvents } from './organizations/user-events.js';
import { VerificationEvents } from './organizations/verification-events.js';
import { PrismaModule, PrismaService } from './prisma.service.js';

@Module({
  imports: coreModules({ serviceName: SERVICE_NAME, env, prismaService: PrismaService, prismaModule: PrismaModule }),
  controllers: [OrganizationsController, InvitationsController, InternalController, InternalUsersController, AddressesController],
  providers: [OrganizationsService, AddressesService, InvitationsService, VerificationEvents, UserEvents, OutboxRelayHost(PrismaService)],
})
export class AppModule {}
