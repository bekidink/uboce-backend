import type {
  InternalMembership,
  InternalOrganization,
  InternalOrganizationMember,
  InternalUser,
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
