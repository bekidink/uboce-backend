import { type DynamicModule, Global, Module } from '@nestjs/common';

import { ActingOrganizationGuard } from './acting-organization.js';
import { IdentityClient, MessagesClient, OrganizationsClient } from './clients.js';
import { InternalClient } from './internal-client.js';

export interface InternalModuleOptions {
  clientId: string;
  clientSecret: string;
  identityUrl: string;
  organizationUrl?: string;
  notificationUrl?: string;
}

/** Service-to-service clients, authenticated with this service's own credentials. */
@Global()
@Module({})
export class InternalModule {
  static forRoot(options: InternalModuleOptions): DynamicModule {
    const http = new InternalClient(options);
    return {
      module: InternalModule,
      providers: [
        { provide: InternalClient, useValue: http },
        { provide: IdentityClient, useValue: new IdentityClient(http, options.identityUrl) },
        { provide: OrganizationsClient, useValue: new OrganizationsClient(http, options.organizationUrl) },
        { provide: MessagesClient, useValue: new MessagesClient(http, options.notificationUrl) },
        ActingOrganizationGuard,
      ],
      exports: [InternalClient, IdentityClient, OrganizationsClient, MessagesClient, ActingOrganizationGuard],
    };
  }
}
