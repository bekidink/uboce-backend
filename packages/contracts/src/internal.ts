// Internal (service-to-service) API contracts. These routes live under
// /api/v1/internal, require a service token, and are never exposed by the gateway.

export const INTERNAL_AUDIENCE = 'uboce-internal';

/** Identity: GET /internal/users/:userId, GET /internal/users?email= */
export interface InternalUser {
  id: string;
  email: string;
  emailVerified: boolean;
  mfaEnabled: boolean;
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

/** Administration: GET /internal/platform-roles/:userId */
export interface InternalPlatformRoles {
  userId: string;
  /** e.g. platform_admin, verification_reviewer, dispute_reviewer, support */
  roles: string[];
}

/** Inventory: POST /internal/movements (idempotent on idempotencyKey) */
export interface PostMovementRequest {
  idempotencyKey: string;
  organizationId: string;
  warehouseId: string;
  itemId: string;
  type: 'receipt' | 'issue' | 'adjustment' | 'production_issue' | 'production_output' | 'transfer_in' | 'transfer_out';
  /** Signed decimal: positive adds stock, negative removes it. */
  quantity: string;
  unitOfMeasure?: string;
  sourceType: string;
  sourceId: string;
  note?: string;
  /** Draw down an existing reservation instead of free stock (e.g. dispatching a confirmed order). */
  reservation?: { referenceType: 'order' | 'production_order'; referenceId: string };
}

/** Warehouse: GET /internal/warehouses/:warehouseId */
export interface InternalWarehouse {
  id: string;
  organizationId: string;
  name: string;
  status: string;
}

/** Inventory: POST /internal/reservations (idempotent on referenceType + referenceId) */
export interface ReserveStockRequest {
  organizationId: string;
  referenceType: 'order' | 'production_order';
  referenceId: string;
  lines: { itemId: string; quantity: string; warehouseId?: string }[];
}

export interface ReserveStockResult {
  reservationId: string;
  status: 'active' | 'failed';
  shortages: { itemId: string; requested: string; available: string }[];
}

/** Document: GET /internal/documents/:documentId */
export interface InternalDocument {
  id: string;
  ownerOrganizationId: string | null;
  ownerUserId: string;
  classification: string;
  status: string;
  contentType: string;
  sha256: string | null;
}

/** Finance: POST /internal/payment-notifications (from Integration, already verified) */
export interface PaymentNotification {
  provider: string;
  externalReference: string;
  invoiceNumber: string;
  amount: string;
  currency: string;
  status: 'confirmed' | 'failed' | 'reversed';
  occurredAt: string;
}

/** Logistics: POST /internal/tracking-events (from Integration, already verified) */
export interface CarrierTrackingEvent {
  provider: string;
  externalEventId: string;
  trackingNumber: string;
  status: 'in_transit' | 'delivered' | 'failed' | 'returned';
  location?: string;
  occurredAt: string;
}

/** Commerce: GET /internal/orders/:orderId */
export interface InternalOrder {
  id: string;
  number: string;
  buyerOrganizationId: string;
  supplierOrganizationId: string;
  status: string;
  currency: string;
  total: string;
  deliveryLocation: string | null;
  lines: { id: string; lineNumber: number; productId: string | null; description: string; quantity: string; unitOfMeasure: string; unitPrice: string; lineTotal: string; fulfilledQuantity: string }[];
}
