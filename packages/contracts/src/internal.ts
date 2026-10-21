// Internal (service-to-service) API contracts. These routes live under
// /api/v1/internal, require a service token, and are never exposed by the gateway.

export const INTERNAL_AUDIENCE = 'uboce-internal';

/** Identity: GET /internal/users/:userId, GET /internal/users?email= */
export interface InternalUser {
  id: string;
  email: string;
  emailVerified: boolean;
  phone: string | null;
  displayName: string;
  locale: string;
  status: string;
}

/** Organization: GET /internal/organizations/:organizationId/members/:userId */
export interface InternalMembership {
  membershipId: string;
  userId: string;
  role: string;
  organization: InternalOrganization;
}

export interface InternalOrganization {
  id: string;
  name: string;
  type: string;
  countryCode: string;
  status: string;
  verificationStatus: string;
}

/** Organization: GET /internal/organizations/:organizationId/members?roles=a,b */
export interface InternalOrganizationMember {
  userId: string;
  role: string;
}

/**
 * Notification: POST /internal/messages — immediate email/SMS for messages that
 * carry secrets (reset links, invitation links). The rendered body is not stored.
 */
export interface SendMessageRequest {
  channel: 'email' | 'sms';
  to: string;
  template: string;
  locale: string;
  vars: Record<string, string>;
  /** Identity user ID when the recipient has an account. */
  userId?: string;
}
