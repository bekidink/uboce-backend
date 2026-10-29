// Stage 3–6 event payloads: fulfillment, industry modules, verification,
// finance, disputes. Decimal strings for quantities and money, as elsewhere.

// ---- Inventory (S09) -----------------------------------------------------------

export interface StockReservedV1 {
  reservationId: string;
  organizationId: string;
  orderId: string;
  lines: { itemId: string; warehouseId: string; quantity: string }[];
}

export interface StockReservationFailedV1 {
  organizationId: string;
  orderId: string;
  reason: string;
  shortages: { itemId: string; requested: string; available: string }[];
}

export interface StockMovementPostedV1 {
  movementId: string;
  organizationId: string;
  warehouseId: string;
  itemId: string;
  type: string;
  /** Signed: positive adds stock, negative removes it. */
  quantity: string;
  sourceType: string;
  sourceId: string;
}

// ---- Warehouse (S10) -------------------------------------------------------------

export interface GoodsReceivedV1 {
  receiptId: string;
  organizationId: string;
  warehouseId: string;
  orderId: string | null;
  shipmentId: string | null;
  inspectionRequired: boolean;
  lines: { itemId: string; orderLineId: string | null; receivedQuantity: string; rejectedQuantity: string }[];
}

// ---- Quality (S14) ------------------------------------------------------------------

export interface InspectionCompletedV1 {
  inspectionId: string;
  organizationId: string;
  subjectType: 'receipt' | 'produce_lot' | 'batch' | 'product';
  subjectId: string;
  decision: 'accepted' | 'rejected' | 'conditionally_accepted';
  lines: { itemId: string; acceptedQuantity: string; rejectedQuantity: string }[];
}

// ---- Logistics (S13) -------------------------------------------------------------

export interface ShipmentDispatchedV1 {
  shipmentId: string;
  orderId: string;
  shipperOrganizationId: string;
  consigneeOrganizationId: string;
  originWarehouseId: string | null;
  items: { orderLineId: string; itemId: string | null; quantity: string }[];
  dispatchedAt: string;
}

export interface DeliveryConfirmedV1 {
  shipmentId: string;
  orderId: string;
  shipperOrganizationId: string;
  consigneeOrganizationId: string;
  /** True when every dispatched item arrived. */
  complete: boolean;
  items: { orderLineId: string; deliveredQuantity: string }[];
  deliveredAt: string;
}

// ---- Commerce follow-ups (S08) ----------------------------------------------------

export interface PurchaseOrderFulfillmentUpdatedV1 {
  orderId: string;
  orderNumber: string;
  buyerOrganizationId: string;
  supplierOrganizationId: string;
  status: string;
  /** A pickup order was handed over: Inventory issues the reserved stock. */
  handover?: boolean;
}

// ---- Agriculture (S11) -------------------------------------------------------------

export interface ProduceLotCreatedV1 {
  lotId: string;
  lotCode: string;
  organizationId: string;
  productId: string | null;
  crop: string;
  quantity: string;
  unitOfMeasure: string;
  grade: string | null;
  warehouseId: string | null;
  /** Lots this one was aggregated, split or merged from. */
  parentLotIds: string[];
}

// ---- Manufacturing (S12) -------------------------------------------------------------

export interface ProductionCompletedV1 {
  productionOrderId: string;
  runId: string;
  organizationId: string;
  outputItemId: string;
  outputQuantity: string;
  batchId: string;
  batchCode: string;
  wasteQuantity: string;
}

// ---- Verification (S03, S04) -------------------------------------------------------------

export interface VerificationDecidedV1 {
  caseId: string;
  /** User ID for KYC, organization ID for KYB. */
  subjectId: string;
  tier: string;
  /** 'submitted' announces a case entering review; the rest are outcomes. */
  decision: 'submitted' | 'approved' | 'rejected' | 'needs_information' | 'suspended' | 'expired';
  reasonCode: string | null;
  policyVersion: string;
  expiresAt: string | null;
}

// ---- Finance operations (S15) ----------------------------------------------------------

export interface InvoiceIssuedV1 {
  invoiceId: string;
  invoiceNumber: string;
  orderId: string | null;
  sellerOrganizationId: string;
  buyerOrganizationId: string;
  total: string;
  currency: string;
  dueDate: string;
}

export interface ReconciliationUpdatedV1 {
  invoiceId: string;
  invoiceNumber: string;
  orderId: string | null;
  sellerOrganizationId: string;
  buyerOrganizationId: string;
  status: string;
  paidAmount: string;
  outstanding: string;
  currency: string;
}

// ---- Disputes (S18) ------------------------------------------------------------------

export interface DisputeOpenedV1 {
  disputeId: string;
  subjectType: string;
  subjectId: string;
  orderId: string | null;
  openedByOrganizationId: string;
  againstOrganizationId: string;
  category: string;
}

export interface DisputeResolvedV1 {
  disputeId: string;
  subjectType: string;
  subjectId: string;
  openedByOrganizationId: string;
  againstOrganizationId: string;
  outcome: string;
}
