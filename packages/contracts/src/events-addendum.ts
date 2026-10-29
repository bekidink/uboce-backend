// Events added by PRD Addendum v1.1 (returns, refunds, logistics states, reviews, chat, entitlements).

export interface ReturnRequestedV1 {
  returnId: string;
  orderId: string;
  orderNumber: string;
  buyerOrganizationId: string;
  supplierOrganizationId: string;
  reason: string;
}

/** The supplier decided on (approved/rejected) or received a return. */
export interface ReturnStatusChangedV1 {
  returnId: string;
  orderId: string;
  orderNumber: string;
  buyerOrganizationId: string;
  supplierOrganizationId: string;
  status: string;
  /** What the buyer is owed for a received return (after restocking fees). */
  refundAmount: string;
  currency: string;
  note: string | null;
}

/** A buyer cancelled after the free window, or didn't collect: the fee per the order's policy snapshot. */
export interface OrderChargeAssessedV1 {
  orderId: string;
  orderNumber: string;
  buyerOrganizationId: string;
  supplierOrganizationId: string;
  kind: 'cancellation_fee' | 'no_show_fee';
  amount: string;
  currency: string;
  policyVersion: number | null;
}

export interface RefundStatusChangedV1 {
  refundId: string;
  orderId: string | null;
  invoiceId: string | null;
  returnId: string | null;
  sellerOrganizationId: string;
  buyerOrganizationId: string;
  status: string;
  amount: string;
  currency: string;
  provider: string | null;
}

/** Logistics shipment lifecycle beyond dispatch/delivery (planned, assigned, picked up, delayed, failed…). */
export interface ShipmentStatusChangedV1 {
  shipmentId: string;
  orderIds: string[];
  shipperOrganizationId: string;
  consigneeOrganizationId: string;
  /** The logistics provider carrying it, if any. */
  carrierOrganizationId?: string | null;
  status: string;
  reason: string | null;
}

export interface ReviewPublishedV1 {
  reviewId: string;
  orderId: string;
  subjectOrganizationId: string;
  productId: string | null;
  rating: number;
}

export interface QualityClaimOpenedV1 {
  claimId: string;
  orderId: string;
  buyerOrganizationId: string;
  supplierOrganizationId: string;
  reason: string;
}

export interface ChatMessageSentV1 {
  conversationId: string;
  messageId: string;
  subject: string;
  senderUserId: string;
  senderOrganizationId: string;
  /** Organizations to notify (every participant except the sender's). */
  recipientOrganizationIds: string[];
  preview: string;
}

export interface EntitlementChangedV1 {
  organizationId: string;
  moduleKey: string;
  enabled: boolean;
  validUntil: string | null;
}

/** An organization's active locations changed: where it delivers and where buyers can collect. */
export interface OrganizationLocationsChangedV1 {
  organizationId: string;
  serviceAreas: string[];
  pickupCities: string[];
}

/** A supplier asked a logistics provider to carry a shipment (or the provider answered). */
export interface ShipmentCarrierChangedV1 {
  shipmentId: string;
  orderNumber: string;
  shipperOrganizationId: string;
  consigneeOrganizationId: string;
  carrierOrganizationId: string;
  status: 'requested' | 'accepted' | 'declined' | 'removed';
  note: string | null;
}
