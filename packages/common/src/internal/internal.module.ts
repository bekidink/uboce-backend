import { type DynamicModule, Global, Module } from '@nestjs/common';

import { ActingOrganizationGuard } from './acting-organization.js';
import {
  AdministrationClient,
  CommerceClient,
  DocumentsClient,
  FinanceClient,
  IdentityClient,
  InventoryClient,
  LogisticsClient,
  MessagesClient,
  OrganizationsClient,
  WarehousesClient,
} from './clients.js';
import { InternalClient } from './internal-client.js';
import { PlatformRoleGuard } from './platform-roles.js';

export interface InternalModuleOptions {
  clientId: string;
  clientSecret: string;
  identityUrl: string;
  organizationUrl?: string;
  notificationUrl?: string;
  administrationUrl?: string;
  inventoryUrl?: string;
  documentUrl?: string;
  financeUrl?: string;
  logisticsUrl?: string;
  warehouseUrl?: string;
  commerceUrl?: string;
}

const CLIENTS = [IdentityClient, OrganizationsClient, MessagesClient, AdministrationClient, InventoryClient, DocumentsClient, FinanceClient, LogisticsClient, WarehousesClient, CommerceClient];

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
        { provide: AdministrationClient, useValue: new AdministrationClient(http, options.administrationUrl) },
        { provide: InventoryClient, useValue: new InventoryClient(http, options.inventoryUrl) },
        { provide: DocumentsClient, useValue: new DocumentsClient(http, options.documentUrl) },
        { provide: FinanceClient, useValue: new FinanceClient(http, options.financeUrl) },
        { provide: LogisticsClient, useValue: new LogisticsClient(http, options.logisticsUrl) },
        { provide: WarehousesClient, useValue: new WarehousesClient(http, options.warehouseUrl) },
        { provide: CommerceClient, useValue: new CommerceClient(http, options.commerceUrl) },
        ActingOrganizationGuard,
        PlatformRoleGuard,
      ],
      exports: [InternalClient, ...CLIENTS, ActingOrganizationGuard, PlatformRoleGuard],
    };
  }
}
