import type { DomainEvent, EventType } from '@uboce/contracts';

// Event → counter increments. Pure, so the projection rules are easy to review
// and test. Each increment is (organization, metric, amount, currency?).

export interface Increment {
  organizationId: string;
  metric: string;
  amount: string;
  currency?: string;
}

const one = (organizationId: string, metric: string): Increment => ({ organizationId, metric, amount: '1' });

type Projector<T extends EventType> = (e: DomainEvent<T>) => Increment[];

export const PROJECTIONS: { [T in EventType]?: Projector<T> } = {
  RFQPublished: (e) => [one(e.data.buyerOrganizationId, 'rfqs_published')],
  // Revisions are the same quotation; count only the first submission.
  QuotationSubmitted: (e) =>
    e.data.revision === 1 ? [one(e.data.supplierOrganizationId, 'quotations_submitted'), one(e.data.buyerOrganizationId, 'quotations_received')] : [],
  QuotationAccepted: (e) => [one(e.data.buyerOrganizationId, 'quotations_accepted'), one(e.data.supplierOrganizationId, 'quotations_won')],
  PurchaseOrderCreated: (e) => [
    one(e.data.buyerOrganizationId, 'orders_placed'),
    { organizationId: e.data.buyerOrganizationId, metric: 'purchase_value', amount: e.data.total, currency: e.data.currency },
    one(e.data.supplierOrganizationId, 'orders_received'),
    { organizationId: e.data.supplierOrganizationId, metric: 'sales_value', amount: e.data.total, currency: e.data.currency },
  ],
  PurchaseOrderConfirmed: (e) => [one(e.data.supplierOrganizationId, 'orders_confirmed')],
  PurchaseOrderCancelled: (e) => [one(e.data.buyerOrganizationId, 'orders_cancelled'), one(e.data.supplierOrganizationId, 'orders_cancelled')],
  DeliveryConfirmed: (e) => [
    one(e.data.shipperOrganizationId, 'deliveries_made'),
    one(e.data.consigneeOrganizationId, 'deliveries_received'),
    ...(e.data.complete ? [one(e.data.shipperOrganizationId, 'deliveries_complete')] : []),
  ],
  StockMovementPosted: (e) => [one(e.data.organizationId, 'stock_movements')],
  InvoiceIssued: (e) => [
    one(e.data.sellerOrganizationId, 'invoices_issued'),
    { organizationId: e.data.sellerOrganizationId, metric: 'invoiced_value', amount: e.data.total, currency: e.data.currency },
    one(e.data.buyerOrganizationId, 'invoices_received'),
  ],
  ReconciliationUpdated: (e) => (e.data.status === 'paid' ? [one(e.data.sellerOrganizationId, 'invoices_paid')] : []),
  DisputeOpened: (e) => [one(e.data.openedByOrganizationId, 'disputes_opened'), one(e.data.againstOrganizationId, 'disputes_received')],
  ProduceLotCreated: (e) => [one(e.data.organizationId, 'produce_lots_created')],
  ProductionCompleted: (e) => [
    one(e.data.organizationId, 'production_runs'),
    { organizationId: e.data.organizationId, metric: 'waste_quantity', amount: e.data.wasteQuantity },
  ],
};

const rate = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

/** Conversion and reliability rates derived from the counters (PRD 5.20). */
export function derivedRates(totals: Record<string, number>) {
  const t = (k: string) => totals[k] ?? 0;
  return {
    quotationsPerRfq: t('rfqs_published') ? Math.round((t('quotations_received') / t('rfqs_published')) * 100) / 100 : null,
    rfqToOrderRatePct: rate(t('quotations_accepted'), t('rfqs_published')),
    quoteWinRatePct: rate(t('quotations_won'), t('quotations_submitted')),
    orderConfirmationRatePct: rate(t('orders_confirmed'), t('orders_received')),
    completeDeliveryRatePct: rate(t('deliveries_complete'), t('deliveries_made')),
    invoicePaidRatePct: rate(t('invoices_paid'), t('invoices_issued')),
  };
}
