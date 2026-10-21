import type { DomainEvent } from '@uboce/contracts';
import { describe, expect, it } from 'vitest';

import { derivedRates, PROJECTIONS } from './projections.js';

const event = <T extends keyof typeof PROJECTIONS>(type: T, data: unknown) =>
  ({ eventId: 'e', eventType: type, schemaVersion: 1, occurredAt: '2026-10-21T10:00:00Z', producer: 'x', aggregateId: 'a', correlationId: null, data }) as unknown as DomainEvent<T>;

describe('analytics projections', () => {
  it('counts orders and value for both sides', () => {
    const incs = PROJECTIONS.PurchaseOrderCreated!(
      event('PurchaseOrderCreated', { orderId: 'o', orderNumber: 'PO', buyerOrganizationId: 'b', supplierOrganizationId: 's', sourceQuotationId: null, total: '1500.00', currency: 'ETB' }),
    );
    expect(incs).toContainEqual({ organizationId: 'b', metric: 'purchase_value', amount: '1500.00', currency: 'ETB' });
    expect(incs).toContainEqual({ organizationId: 's', metric: 'orders_received', amount: '1' });
  });

  it('does not double count quotation revisions', () => {
    expect(PROJECTIONS.QuotationSubmitted!(event('QuotationSubmitted', { revision: 2, buyerOrganizationId: 'b', supplierOrganizationId: 's' }))).toEqual([]);
  });

  it('derives rates and reports null without data', () => {
    expect(derivedRates({ orders_received: 4, orders_confirmed: 3 }).orderConfirmationRatePct).toBe(75);
    expect(derivedRates({}).invoicePaidRatePct).toBeNull();
  });
});
