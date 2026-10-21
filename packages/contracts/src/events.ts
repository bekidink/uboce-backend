import type { EventEnvelope } from './envelope.js';

// Versioned event contracts. A breaking change to a payload means a new
// schemaVersion, and consumers keep handling the old one until producers move.
// Money and quantities are decimal strings (never floats); amounts always carry a currency.

export type Locale = 'en' | 'am';

// ---- Identity ---------------------------------------------------------------

export interface UserRegisteredV1 {
  userId: string;
  email: string;
  displayName: string;
  locale: Locale;
}

// ---- Organization -------------------------------------------------------------

export interface OrganizationCreatedV1 {
  organizationId: string;
  name: string;
  type: string;
  countryCode: string;
  createdByUserId: string;
}

export interface OrganizationUpdatedV1 {
  organizationId: string;
  name: string;
  type: string;
  countryCode: string;
  status: string;
  verificationStatus: string;
}

export interface MembershipAddedV1 {
  organizationId: string;
  membershipId: string;
  userId: string;
  role: string;
  addedByUserId: string;
}

export interface MembershipRevokedV1 {
  organizationId: string;
  membershipId: string;
  userId: string;
  revokedByUserId: string;
}

// ---- Catalog ------------------------------------------------------------------

export interface ProductVariantSnapshot {
  variantId: string;
  sku: string;
  name: string;
  price: string;
  currency: string;
  attributes: Record<string, string>;
}

export interface ProductPublishedV1 {
  productId: string;
  organizationId: string;
  name: string;
  description: string | null;
  categoryId: string;
  categorySlug: string;
  unitOfMeasure: string;
  attributes: Record<string, string>;
  variants: ProductVariantSnapshot[];
  publishedAt: string;
}

export interface ProductArchivedV1 {
  productId: string;
  organizationId: string;
}

// ---- Procurement --------------------------------------------------------------

export interface RfqPublishedV1 {
  rfqId: string;
  buyerOrganizationId: string;
  title: string;
  responseDeadline: string;
  /** Empty means open to every eligible supplier. */
  invitedSupplierOrganizationIds: string[];
  lineCount: number;
}

export interface QuotationSubmittedV1 {
  quotationId: string;
  rfqId: string;
  buyerOrganizationId: string;
  supplierOrganizationId: string;
  revision: number;
  total: string;
  currency: string;
}

export interface QuotationLineSnapshot {
  rfqLineId: string;
  productId: string | null;
  description: string;
  quantity: string;
  unitOfMeasure: string;
  unitPrice: string;
  lineTotal: string;
  leadTimeDays: number | null;
}

/** Immutable commercial snapshot the order is created from (PRD 6.2). */
export interface QuotationAcceptedV1 {
  quotationId: string;
  quotationRevision: number;
  rfqId: string;
  rfqTitle: string;
  buyerOrganizationId: string;
  supplierOrganizationId: string;
  acceptedByUserId: string;
  currency: string;
  deliveryTerms: string | null;
  deliveryLocation: string | null;
  lines: QuotationLineSnapshot[];
  total: string;
}

// ---- Commerce -----------------------------------------------------------------

export interface PurchaseOrderCreatedV1 {
  orderId: string;
  orderNumber: string;
  buyerOrganizationId: string;
  supplierOrganizationId: string;
  sourceQuotationId: string | null;
  total: string;
  currency: string;
}

export interface PurchaseOrderStatusChangedV1 {
  orderId: string;
  orderNumber: string;
  buyerOrganizationId: string;
  supplierOrganizationId: string;
  status: string;
  changedByUserId: string;
  reason: string | null;
}

export interface EventCatalog {
  UserRegistered: UserRegisteredV1;
  OrganizationCreated: OrganizationCreatedV1;
  OrganizationUpdated: OrganizationUpdatedV1;
  MembershipAdded: MembershipAddedV1;
  MembershipRevoked: MembershipRevokedV1;
  ProductPublished: ProductPublishedV1;
  ProductArchived: ProductArchivedV1;
  RFQPublished: RfqPublishedV1;
  QuotationSubmitted: QuotationSubmittedV1;
  QuotationAccepted: QuotationAcceptedV1;
  PurchaseOrderCreated: PurchaseOrderCreatedV1;
  PurchaseOrderConfirmed: PurchaseOrderStatusChangedV1;
  PurchaseOrderCancelled: PurchaseOrderStatusChangedV1;
}

export type EventType = keyof EventCatalog;

export const EVENT_SCHEMA_VERSIONS: Record<EventType, number> = {
  UserRegistered: 1,
  OrganizationCreated: 1,
  OrganizationUpdated: 1,
  MembershipAdded: 1,
  MembershipRevoked: 1,
  ProductPublished: 1,
  ProductArchived: 1,
  RFQPublished: 1,
  QuotationSubmitted: 1,
  QuotationAccepted: 1,
  PurchaseOrderCreated: 1,
  PurchaseOrderConfirmed: 1,
  PurchaseOrderCancelled: 1,
};

export type DomainEvent<T extends EventType = EventType> = EventEnvelope<T, EventCatalog[T]>;
