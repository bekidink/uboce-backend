// Events added by PRD v2.0 (scheduler, finance recovery, stock alerts, SMS).

/** Finance: an invoice passed its due date, or a reminder is due (PLT-03, NTF-10). */
export interface InvoiceOverdueV1 {
  invoiceId: string;
  invoiceNumber: string;
  sellerOrganizationId: string;
  buyerOrganizationId: string;
  outstanding: string;
  currency: string;
  dueDate: string;
  daysOverdue: number;
  /** 1 for the first notice, then each reminder. */
  reminder: number;
}

/** Finance: a payment attempt changed state outside the buyer's session (FIN-05). */
export interface PaymentAttemptUpdatedV1 {
  intentId: string;
  invoiceId: string;
  invoiceNumber: string;
  buyerOrganizationId: string;
  sellerOrganizationId: string;
  provider: string;
  status: 'expired' | 'failed' | 'succeeded';
  reason: string | null;
}

/** Inventory: batches in an organization expire soon (INV-04, NTF-10). One per organization per run. */
export interface StockExpiringV1 {
  organizationId: string;
  batches: number;
  /** ISO date of the soonest expiry. */
  earliestExpiresOn: string;
  withinDays: number;
}

/** Administration: a scheduled job failed repeatedly or missed its window (PLT-02). */
export interface JobFailedV1 {
  job: string;
  service: string;
  kind: 'failed' | 'missed';
  consecutiveFailures: number;
  error: string | null;
}

/** Finance: money was recorded outside a provider: cash, bank transfer or manual (FIN-04, FIN-06). */
export interface ManualPaymentRecordedV1 {
  invoiceId: string;
  invoiceNumber: string;
  sellerOrganizationId: string;
  buyerOrganizationId: string;
  method: 'cash' | 'bank_transfer' | 'mobile_money' | 'cheque';
  amount: string;
  currency: string;
  receiptNumber: string;
  recordedByUserId: string;
}
