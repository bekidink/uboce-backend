import { HttpStatus, Logger } from '@nestjs/common';
import { allocateProRata, AppError, type FinanceClient, InternalCallError, type LogisticsClient } from '@uboce/common';
import type { DeliveryQuote, TaxQuote } from '@uboce/contracts';

import { Prisma } from '../generated/prisma/client.js';

// Delivery fee and tax for a new order (PRD v2 ORD-06, LOG-06, FIN-09, CAT-11).
// Calculated by the server once, at checkout, and stored on the order: later
// rate-card or tax-rule changes never alter a placed order.

const { Decimal } = Prisma;
const logger = new Logger('OrderCharges');

export interface ChargeLine {
  quantity: string;
  unitPrice: string;
  snapshot?: unknown;
}

export interface LineCharges {
  discountAmount: Prisma.Decimal;
  netAmount: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  taxRatePct: Prisma.Decimal | null;
  taxCode: string | null;
}

export interface OrderCharges {
  calculated: boolean;
  deliveryFee: Prisma.Decimal;
  deliveryTax: Prisma.Decimal;
  deliveryTaxRatePct: Prisma.Decimal | null;
  deliveryQuote: DeliveryQuote | null;
  taxTotal: Prisma.Decimal;
  taxInclusive: boolean;
  taxBreakdown: Pick<TaxQuote, 'regime' | 'exemption' | 'calculatedAt' | 'sellerTin'> & { ruleIds: string[] } | null;
  sellerLegalName: string | null;
  lines: LineCharges[];
}

/** No charges: tax not configured in this environment, or a pre-v2 path. */
export function noCharges(lines: ChargeLine[], discount: Prisma.Decimal): OrderCharges {
  const shares = allocateProRata(discount.toFixed(2), lines.map((l) => lineAmount(l).toFixed(2)));
  return {
    calculated: false,
    deliveryFee: new Decimal(0),
    deliveryTax: new Decimal(0),
    deliveryTaxRatePct: null,
    deliveryQuote: null,
    taxTotal: new Decimal(0),
    taxInclusive: false,
    taxBreakdown: null,
    sellerLegalName: null,
    lines: lines.map((l, i) => ({ discountAmount: new Decimal(shares[i]!), netAmount: lineAmount(l).minus(shares[i]!), taxAmount: new Decimal(0), taxRatePct: null, taxCode: null })),
  };
}

const lineAmount = (l: ChargeLine) => new Decimal(l.quantity).times(l.unitPrice).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

const snap = (l: ChargeLine) => (l.snapshot ?? {}) as { taxClass?: string; weightKg?: string | null };

/** Not configured here (e.g. a local run without finance): the call can't be made at all. */
const notConfigured = (error: unknown) => error instanceof Error && /is not configured for this service/.test(error.message);

/** A peer's 4xx (no delivery zone, missing tax rule) is the buyer's or seller's problem: pass it on as 422. */
function passThrough(error: unknown, fallback: string): never {
  if (error instanceof InternalCallError && error.status < 500) {
    const body = (error.body ?? {}) as { error?: { code?: string; message?: string } };
    throw new AppError(HttpStatus.UNPROCESSABLE_ENTITY, body.error?.code ?? 'charges_failed', body.error?.message ?? fallback);
  }
  throw error;
}

export async function computeCharges(
  clients: { finance: FinanceClient; logistics: LogisticsClient },
  input: {
    buyerOrganizationId: string;
    sellerOrganizationId: string;
    currency: string;
    /** Only delivery orders priced by the seller's rate card carry a delivery fee. */
    chargeDelivery: boolean;
    city?: string | null;
    region?: string | null;
    lines: ChargeLine[];
    discount: Prisma.Decimal;
  },
): Promise<OrderCharges> {
  const base = noCharges(input.lines, input.discount);
  const goods = base.lines.reduce((s, l) => s.plus(l.netAmount), new Decimal(0));

  let delivery: DeliveryQuote | null = null;
  if (input.chargeDelivery) {
    const weight = input.lines.reduce((s, l) => s.plus(new Decimal(l.quantity).times(snap(l).weightKg ?? 0)), new Decimal(0));
    try {
      delivery = await clients.logistics.deliveryQuote({
        sellerOrganizationId: input.sellerOrganizationId,
        currency: input.currency,
        goodsAmount: goods.toFixed(2),
        weightKg: weight.toFixed(3),
        city: input.city ?? null,
        region: input.region ?? null,
      });
    } catch (error) {
      if (notConfigured(error)) logger.warn('LOGISTICS_URL is not set: orders carry no delivery fee');
      else passThrough(error, 'Delivery could not be priced');
    }
  }
  const deliveryFee = new Decimal(delivery?.fee ?? 0);

  let tax: TaxQuote | null = null;
  try {
    tax = await clients.finance.taxQuote({
      sellerOrganizationId: input.sellerOrganizationId,
      buyerOrganizationId: input.buyerOrganizationId,
      currency: input.currency,
      lines: [
        ...base.lines.map((l, i) => ({ key: String(i), amount: l.netAmount.toFixed(2), taxClass: snap(input.lines[i]!).taxClass ?? 'standard' })),
        // Delivery is a service the seller sells, taxed like one.
        ...(deliveryFee.gt(0) ? [{ key: 'delivery', amount: deliveryFee.toFixed(2), taxClass: 'service' }] : []),
      ],
    });
  } catch (error) {
    if (notConfigured(error)) {
      logger.warn('FINANCE_URL is not set: orders are placed without tax');
      return { ...base, deliveryFee, deliveryQuote: delivery };
    }
    passThrough(error, 'Tax could not be calculated');
  }

  const byKey = new Map(tax.lines.map((l) => [l.key, l]));
  const deliveryLine = byKey.get('delivery');
  return {
    calculated: true,
    deliveryFee,
    deliveryTax: new Decimal(deliveryLine?.tax ?? 0),
    deliveryTaxRatePct: deliveryLine ? new Decimal(deliveryLine.ratePct) : null,
    deliveryQuote: delivery,
    taxTotal: new Decimal(tax.tax),
    taxInclusive: tax.inclusive,
    taxBreakdown: { regime: tax.regime, exemption: tax.exemption, calculatedAt: tax.calculatedAt, sellerTin: tax.sellerTin, ruleIds: [...new Set(tax.lines.map((l) => l.ruleId).filter((x): x is string => !!x))] },
    sellerLegalName: tax.sellerLegalName,
    lines: base.lines.map((l, i) => {
      const t = byKey.get(String(i))!;
      // Inclusive prices: the net is what remains after taking the tax out.
      return { ...l, netAmount: new Decimal(t.net), taxAmount: new Decimal(t.tax), taxRatePct: new Decimal(t.ratePct), taxCode: t.taxCode };
    }),
  };
}

/**
 * Built from the same per-line amounts the invoice copies, so the two match to
 * the cent: lines (net + tax), plus delivery (plus its tax when prices exclude tax).
 */
export function orderTotal(c: OrderCharges) {
  const goods = c.lines.reduce((s, l) => s.plus(l.netAmount).plus(l.taxAmount), new Decimal(0));
  return goods.plus(c.deliveryFee).plus(c.taxInclusive ? 0 : c.deliveryTax);
}
