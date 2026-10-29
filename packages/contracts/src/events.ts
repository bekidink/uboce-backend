import type { EventEnvelope } from './envelope.js';
import type * as Add from './events-addendum.js';
import type * as Ops from './events-operations.js';

export type * from './events-addendum.js';
export type * from './events-operations.js';

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

/** Suspension, reactivation, role or location-scope change (PRD addendum 2.2). */
export interface MembershipUpdatedV1 {
  organizationId: string;
  membershipId: string;
  userId: string;
  role: string;
  status: string;
  /** Empty: the whole organization. */
  locationIds: string[];
  changedByUserId: string;
}

// ---- Catalog ------------------------------------------------------------------

export interface ProductVariantSnapshot {
  variantId: string;
  sku: string;
  name: string;
  price: string;
  currency: string;
  attributes: Record<string, string>;
  minOrderQuantity?: string | null;
  /** Lowest tier price, for "from" prices in search. */
  lowestTierPrice?: string | null;
}

export interface ProductPublishedV1 {
  productId: string;
  organizationId: string;
  name: string;
  description: string | null;
  categoryId: string;
  categorySlug: string;
  /** Category slugs from the sector down (e.g. ["agriculture", "coffee"]), for sector-wide search. */
  categoryPath?: string[];
  unitOfMeasure: string;
  attributes: Record<string, string>;
  variants: ProductVariantSnapshot[];
  publishedAt: string;
  imageDocumentId?: string | null;
  /** Seasonal availability (PRD addendum 2.4). */
  availableFrom?: string | null;
  availableUntil?: string | null;
  allowPreorder?: boolean;
  madeToOrder?: boolean;
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
  /** Which side made the change. */
  party: 'buyer' | 'supplier';
  orderId: string;
  orderNumber: string;
  buyerOrganizationId: string;
  supplierOrganizationId: string;
  status: string;
  changedByUserId: string;
  reason: string | null;
  /** Fee charged under the order's cancellation policy, if any. */
  cancellationFee?: string | null;
}

/** Confirmation carries the lines so Inventory can reserve stock without calling back. */
export interface PurchaseOrderConfirmedV1 extends PurchaseOrderStatusChangedV1 {
  lines: { orderLineId: string; productId: string | null; quantity: string; unitOfMeasure: string }[];
}

export interface EventCatalog {
  UserRegistered: UserRegisteredV1;
  OrganizationCreated: OrganizationCreatedV1;
  OrganizationUpdated: OrganizationUpdatedV1;
  MembershipAdded: MembershipAddedV1;
  MembershipRevoked: MembershipRevokedV1;
  MembershipUpdated: MembershipUpdatedV1;
  ProductPublished: ProductPublishedV1;
  ProductArchived: ProductArchivedV1;
  RFQPublished: RfqPublishedV1;
  QuotationSubmitted: QuotationSubmittedV1;
  QuotationAccepted: QuotationAcceptedV1;
  PurchaseOrderCreated: PurchaseOrderCreatedV1;
  PurchaseOrderConfirmed: PurchaseOrderConfirmedV1;
  PurchaseOrderCancelled: PurchaseOrderStatusChangedV1;
  StockReserved: Ops.StockReservedV1;
  StockReservationFailed: Ops.StockReservationFailedV1;
  StockMovementPosted: Ops.StockMovementPostedV1;
  GoodsReceived: Ops.GoodsReceivedV1;
  InspectionCompleted: Ops.InspectionCompletedV1;
  ShipmentDispatched: Ops.ShipmentDispatchedV1;
  DeliveryConfirmed: Ops.DeliveryConfirmedV1;
  PurchaseOrderFulfillmentUpdated: Ops.PurchaseOrderFulfillmentUpdatedV1;
  ProduceLotCreated: Ops.ProduceLotCreatedV1;
  ProductionCompleted: Ops.ProductionCompletedV1;
  KycVerificationDecided: Ops.VerificationDecidedV1;
  KybVerificationDecided: Ops.VerificationDecidedV1;
  InvoiceIssued: Ops.InvoiceIssuedV1;
  ReconciliationUpdated: Ops.ReconciliationUpdatedV1;
  DisputeOpened: Ops.DisputeOpenedV1;
  DisputeResolved: Ops.DisputeResolvedV1;
  ReturnRequested: Add.ReturnRequestedV1;
  ReturnStatusChanged: Add.ReturnStatusChangedV1;
  OrderChargeAssessed: Add.OrderChargeAssessedV1;
  RefundStatusChanged: Add.RefundStatusChangedV1;
  ShipmentStatusChanged: Add.ShipmentStatusChangedV1;
  ReviewPublished: Add.ReviewPublishedV1;
  QualityClaimOpened: Add.QualityClaimOpenedV1;
  ChatMessageSent: Add.ChatMessageSentV1;
  EntitlementChanged: Add.EntitlementChangedV1;
  OrganizationLocationsChanged: Add.OrganizationLocationsChangedV1;
  ShipmentCarrierChanged: Add.ShipmentCarrierChangedV1;
}

export type EventType = keyof EventCatalog;

export const EVENT_SCHEMA_VERSIONS: Record<EventType, number> = {
  UserRegistered: 1,
  OrganizationCreated: 1,
  OrganizationUpdated: 1,
  MembershipAdded: 1,
  MembershipRevoked: 1,
  MembershipUpdated: 1,
  ProductPublished: 1,
  ProductArchived: 1,
  RFQPublished: 1,
  QuotationSubmitted: 1,
  QuotationAccepted: 1,
  PurchaseOrderCreated: 1,
  PurchaseOrderConfirmed: 1,
  PurchaseOrderCancelled: 1,
  StockReserved: 1,
  StockReservationFailed: 1,
  StockMovementPosted: 1,
  GoodsReceived: 1,
  InspectionCompleted: 1,
  ShipmentDispatched: 1,
  DeliveryConfirmed: 1,
  PurchaseOrderFulfillmentUpdated: 1,
  ProduceLotCreated: 1,
  ProductionCompleted: 1,
  KycVerificationDecided: 1,
  KybVerificationDecided: 1,
  InvoiceIssued: 1,
  ReconciliationUpdated: 1,
  DisputeOpened: 1,
  DisputeResolved: 1,
  ReturnRequested: 1,
  ReturnStatusChanged: 1,
  OrderChargeAssessed: 1,
  RefundStatusChanged: 1,
  ShipmentStatusChanged: 1,
  ReviewPublished: 1,
  QualityClaimOpened: 1,
  ChatMessageSent: 1,
  EntitlementChanged: 1,
  OrganizationLocationsChanged: 1,
  ShipmentCarrierChanged: 1,
};

export type DomainEvent<T extends EventType = EventType> = EventEnvelope<T, EventCatalog[T]>;
