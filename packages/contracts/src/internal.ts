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
  /** Locations (branch IDs) the member is limited to; empty means the whole organization. */
  locationIds: string[];
  /** From the member's role template: only these module:action permissions. Null: no template (role decides). */
  permissions?: string[] | null;
  /** Largest commitment the member may approve, from the role template. Null: no limit. */
  approvalLimit?: { amount: string; currency: string } | null;
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
/** An organization location (branch): store, warehouse site, collection point… */
export interface InternalBranch {
  id: string;
  organizationId: string;
  name: string;
  kind: string;
  active: boolean;
  pickupEnabled: boolean;
  fulfillment: boolean;
}

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
  /** Provider fee, when the provider reports it. */
  fee?: string | null;
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
  /** Order-level discount from promotions/coupons (already subtracted from total). */
  discountTotal: string;
  promotionCode: string | null;
  fulfillmentBranchId: string | null;
  lines: { id: string; lineNumber: number; productId: string | null; description: string; quantity: string; unitOfMeasure: string; unitPrice: string; lineTotal: string; fulfilledQuantity: string }[];
}

/** Catalog: POST /internal/catalog/quote — server-side prices and snapshots for order lines (PRD addendum 2.3–2.4). */
export interface CatalogQuoteRequest {
  supplierOrganizationId: string;
  buyerOrganizationId: string;
  currency: string;
  /** The supplier location fulfilling the order, for location price lists. */
  branchId?: string | null;
  lines: { variantId: string; quantity: string; optionIds?: string[] }[];
}

export interface ProductSnapshot {
  productId: string;
  productName: string;
  variantId: string;
  variantName: string;
  sku: string;
  barcode: string | null;
  categorySlug: string;
  unitOfMeasure: string;
  attributes: Record<string, string>;
  variantAttributes: Record<string, string>;
  options: { groupName: string; optionId: string; name: string; priceDelta: string }[];
  imageDocumentId: string | null;
  packSize: string | null;
  preorder: boolean;
  capturedAt: string;
}

export interface CatalogQuoteLine {
  variantId: string;
  productId: string;
  description: string;
  quantity: string;
  unitOfMeasure: string;
  /** Final unit price including options. */
  unitPrice: string;
  /** The variant's list price, before tiers or price lists. */
  listPrice: string;
  priceSource: 'list' | 'tier' | 'price_list';
  priceListId: string | null;
  leadTimeDays: number | null;
  snapshot: ProductSnapshot;
}

export interface CatalogQuote {
  currency: string;
  lines: CatalogQuoteLine[];
  subtotal: string;
}

/** Finance: POST /internal/refund-notifications (from Integration, already verified) */
export interface RefundNotification {
  provider: string;
  refundNumber: string;
  status: 'succeeded' | 'failed';
  providerRef?: string;
  reason?: string;
}

/** Logistics: GET /internal/shipments/:id — the parties to a shipment. */
export interface InternalShipment {
  id: string;
  orderNumber: string;
  shipperOrganizationId: string;
  consigneeOrganizationId: string;
  carrierOrganizationId: string | null;
  status: string;
}
