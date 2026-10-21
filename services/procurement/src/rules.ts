import { Prisma } from './generated/prisma/client.js';

const { Decimal } = Prisma;
type Decimal = Prisma.Decimal;

// Procurement rules (PRD 5.7) without I/O, so they're easy to test and review.

export const BUYER_ROLES = ['owner', 'admin', 'procurement_officer'];
export const SUPPLIER_ROLES = ['owner', 'admin', 'sales_representative'];
/** Roles that may read (but not act on) procurement records. */
export const READ_ROLES = [...new Set([...BUYER_ROLES, ...SUPPLIER_ROLES, 'finance_officer', 'auditor'])];

export interface RfqForEligibility {
  buyerOrganizationId: string;
  status: string;
  visibility: 'open' | 'invited';
  responseDeadline: Date;
  invitedSupplierIds: string[];
}

/** Can this supplier organization see the RFQ at all? */
export function canSupplierSee(rfq: RfqForEligibility, supplierId: string) {
  if (rfq.buyerOrganizationId === supplierId) return false;
  if (rfq.status === 'draft') return false;
  return rfq.visibility === 'open' || rfq.invitedSupplierIds.includes(supplierId);
}

/** Why this supplier can't quote right now, or null if they can. */
export function quotingBlocker(rfq: RfqForEligibility, supplierId: string, now = new Date()): string | null {
  if (!canSupplierSee(rfq, supplierId)) return 'not_invited';
  if (rfq.status !== 'published') return 'rfq_not_open';
  if (rfq.responseDeadline <= now) return 'deadline_passed';
  return null;
}

export interface QuoteLineInput {
  rfqLineId: string;
  unitPrice: string;
  leadTimeDays?: number;
}

export interface RfqLineForQuote {
  id: string;
  quantity: Decimal | string;
}

/**
 * Prices every RFQ line exactly once and computes totals with decimal maths.
 * Throws a readable message for the caller to turn into a 400.
 */
export function priceQuotation(rfqLines: RfqLineForQuote[], input: QuoteLineInput[]) {
  const byId = new Map(input.map((l) => [l.rfqLineId, l]));
  if (byId.size !== input.length) throw new Error('Each RFQ line may be priced only once');
  const unknown = input.filter((l) => !rfqLines.some((r) => r.id === l.rfqLineId));
  if (unknown.length) throw new Error('Quotation refers to lines that are not on this RFQ');
  const missing = rfqLines.filter((r) => !byId.has(r.id));
  if (missing.length) throw new Error('Every RFQ line must be priced');

  let total = new Decimal(0);
  const lines = rfqLines.map((r) => {
    const l = byId.get(r.id)!;
    const quantity = new Decimal(r.quantity);
    const unitPrice = new Decimal(l.unitPrice);
    const lineTotal = quantity.times(unitPrice).toDecimalPlaces(4);
    total = total.plus(lineTotal);
    return { rfqLineId: r.id, quantity, unitPrice, lineTotal, leadTimeDays: l.leadTimeDays ?? null };
  });
  return { lines, total };
}
