import type {
  InternalMembership,
  InternalOrganization,
  InternalOrder,
  InternalOrganizationMember,
  InternalUser,
  InternalWarehouse,
  CarrierTrackingEvent,
  InternalDocument,
  InternalPlatformRoles,
  PaymentNotification,
  PostMovementRequest,
  ReserveStockRequest,
  ReserveStockResult,
  SendMessageRequest,
} from '@uboce/contracts';

import { InternalCallError, type InternalClient } from './internal-client.js';

abstract class ServiceClient {
  constructor(
    protected readonly http: InternalClient,
    private readonly baseUrl: string | undefined,
    private readonly setting: string,
  ) {}

  /** Fails on use, not at startup, so services only configure the peers they call. */
  protected url(path: string) {
    if (!this.baseUrl) throw new Error(`${this.setting} is not configured for this service`);
    return `${this.baseUrl}/api/v1/internal${path}`;
  }
}

const notFoundAsNull = (error: unknown) => {
  if (error instanceof InternalCallError && error.status === 404) return null;
  throw error;
};

export class IdentityClient extends ServiceClient {
  constructor(http: InternalClient, baseUrl: string | undefined) {
    super(http, baseUrl, 'IDENTITY_URL');
  }

  getUser(userId: string) {
    return this.http.get<InternalUser>(this.url(`/users/${userId}`)).catch(notFoundAsNull);
  }

  findByEmail(email: string) {
    return this.http.get<InternalUser>(this.url(`/users?email=${encodeURIComponent(email)}`)).catch(notFoundAsNull);
  }
}

export class OrganizationsClient extends ServiceClient {
  constructor(http: InternalClient, baseUrl: string | undefined) {
    super(http, baseUrl, 'ORGANIZATION_URL');
  }

  getOrganization(organizationId: string) {
    return this.http.get<InternalOrganization>(this.url(`/organizations/${organizationId}`)).catch(notFoundAsNull);
  }

  /** The user's active membership, or null when they don't belong to the organization. */
  getMembership(organizationId: string, userId: string) {
    return this.http
      .get<InternalMembership>(this.url(`/organizations/${organizationId}/members/${userId}`))
      .catch(notFoundAsNull);
  }

  setStatus(organizationId: string, status: 'active' | 'suspended' | 'closed') {
    return this.http.post<InternalOrganization>(this.url(`/organizations/${organizationId}/status`), { status });
  }

  listMembers(organizationId: string, roles: string[] = []) {
    const query = roles.length ? `?roles=${roles.join(',')}` : '';
    return this.http.get<InternalOrganizationMember[]>(this.url(`/organizations/${organizationId}/members${query}`));
  }
}

export class MessagesClient extends ServiceClient {
  constructor(http: InternalClient, baseUrl: string | undefined) {
    super(http, baseUrl, 'NOTIFICATION_URL');
  }

  send(message: SendMessageRequest) {
    return this.http.post<{ status: string }>(this.url('/messages'), message);
  }
}

export class AdministrationClient extends ServiceClient {
  constructor(http: InternalClient, baseUrl: string | undefined) {
    super(http, baseUrl, 'ADMINISTRATION_URL');
  }

  async platformRoles(userId: string): Promise<string[]> {
    const result = await this.http.get<InternalPlatformRoles>(this.url(`/platform-roles/${userId}`)).catch(notFoundAsNull);
    return result?.roles ?? [];
  }
}

export class InventoryClient extends ServiceClient {
  constructor(http: InternalClient, baseUrl: string | undefined) {
    super(http, baseUrl, 'INVENTORY_URL');
  }

  /** Idempotent: the same idempotencyKey never posts twice. */
  postMovement(request: PostMovementRequest) {
    return this.http.post<{ movementId: string; replayed: boolean }>(this.url('/movements'), request);
  }

  reserve(request: ReserveStockRequest) {
    return this.http.post<ReserveStockResult>(this.url('/reservations'), request);
  }

  /** Releases whatever is still reserved for the reference. Safe to repeat. */
  release(referenceType: ReserveStockRequest['referenceType'], referenceId: string) {
    return this.http.post<{ released: boolean }>(this.url(`/reservations/${referenceType}/${referenceId}/release`), {});
  }
}

export class DocumentsClient extends ServiceClient {
  constructor(http: InternalClient, baseUrl: string | undefined) {
    super(http, baseUrl, 'DOCUMENT_URL');
  }

  get(documentId: string) {
    return this.http.get<InternalDocument>(this.url(`/documents/${documentId}`)).catch(notFoundAsNull);
  }

  /** Lets an organization (e.g. a dispute's other party, or a reviewer case) read a document. */
  grant(documentId: string, grantee: { type: 'organization' | 'case'; id: string }, reason: string) {
    return this.http.post<{ granted: boolean }>(this.url(`/documents/${documentId}/grants`), { ...grantee, reason });
  }
}

export class FinanceClient extends ServiceClient {
  constructor(http: InternalClient, baseUrl: string | undefined) {
    super(http, baseUrl, 'FINANCE_URL');
  }

  paymentNotification(notification: PaymentNotification) {
    return this.http.post<{ applied: boolean }>(this.url('/payment-notifications'), notification);
  }
}

export class LogisticsClient extends ServiceClient {
  constructor(http: InternalClient, baseUrl: string | undefined) {
    super(http, baseUrl, 'LOGISTICS_URL');
  }

  trackingEvent(event: CarrierTrackingEvent) {
    return this.http.post<{ applied: boolean }>(this.url('/tracking-events'), event);
  }
}

export class WarehousesClient extends ServiceClient {
  constructor(http: InternalClient, baseUrl: string | undefined) {
    super(http, baseUrl, 'WAREHOUSE_URL');
  }

  get(warehouseId: string) {
    return this.http.get<InternalWarehouse>(this.url(`/warehouses/${warehouseId}`)).catch(notFoundAsNull);
  }
}

export class CommerceClient extends ServiceClient {
  constructor(http: InternalClient, baseUrl: string | undefined) {
    super(http, baseUrl, 'COMMERCE_URL');
  }

  getOrder(orderId: string) {
    return this.http.get<InternalOrder>(this.url('/orders/' + orderId)).catch(notFoundAsNull);
  }
}
