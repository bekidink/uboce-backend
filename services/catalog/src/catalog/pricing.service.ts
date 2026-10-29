import { HttpStatus, Injectable } from '@nestjs/common';
import { type ActingOrganization, AppError, badRequest, conflict, notFound, requirePermission, requireRole, skipTake, toPage, type PaginationQueryDto } from '@uboce/common';
import type { CatalogQuote, CatalogQuoteLine, CatalogQuoteRequest } from '@uboce/contracts';

import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma.service.js';
import type { PriceListDto, PriceTiersDto } from './catalog.dto.js';
import { CATALOG_ROLES, CatalogService } from './catalog.service.js';
import { availability, tierFor } from './publishing.js';

const { Decimal } = Prisma;
type Decimal = Prisma.Decimal;

const quoteError = (code: string, message: string, line?: number) =>
  new AppError(HttpStatus.UNPROCESSABLE_ENTITY, code, line === undefined ? message : `Line ${line}: ${message}`);

/**
 * Prices are decided here, never by the buyer (PRD addendum 2.3–2.4):
 * the lowest of list price, bulk tier and any price list that applies to the buyer.
 */
@Injectable()
export class PricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
  ) {}

  // ---- Bulk tiers -------------------------------------------------------------------

  async setTiers(org: ActingOrganization, productId: string, variantId: string, dto: PriceTiersDto) {
    requireRole(org, CATALOG_ROLES, 'manage prices');
    requirePermission(org, 'prices:manage', 'change prices');
    const product = await this.catalog.owned(org, productId);
    const variant = product.variants.find((v) => v.id === variantId);
    if (!variant) throw notFound('Variant');
    const mins = dto.tiers.map((t) => new Decimal(t.minQuantity));
    if (new Set(mins.map((m) => m.toString())).size !== mins.length) throw badRequest('duplicate_tier', 'Each tier needs its own minimum quantity');
    if (mins.some((m) => m.lte(0))) throw badRequest('invalid_tier', 'Tier minimums must be more than 0');
    // Bigger orders should never cost more per unit.
    const sorted = [...dto.tiers].sort((a, b) => Number(a.minQuantity) - Number(b.minQuantity));
    for (let i = 1; i < sorted.length; i++) {
      if (new Decimal(sorted[i]!.unitPrice).gt(sorted[i - 1]!.unitPrice)) throw badRequest('invalid_tier', 'Tier prices must not rise with quantity');
    }
    if (sorted[0] && new Decimal(sorted[0].unitPrice).gt(variant.price)) throw badRequest('invalid_tier', 'Tier prices must not exceed the list price');

    return this.prisma.$transaction(async (tx) => {
      await tx.variantPriceTier.deleteMany({ where: { variantId } });
      await tx.variantPriceTier.createMany({ data: dto.tiers.map((t) => ({ variantId, minQuantity: t.minQuantity, unitPrice: t.unitPrice })) });
      return this.catalog.afterChange(tx, productId);
    });
  }

  // ---- Price lists ---------------------------------------------------------------------

  async listPriceLists(org: ActingOrganization, query: PaginationQueryDto) {
    requireRole(org, [...CATALOG_ROLES, 'finance_officer', 'auditor'], 'view price lists');
    const where = { organizationId: org.organization.id };
    const [items, total] = await Promise.all([
      this.prisma.priceList.findMany({ where, include: { entries: true }, orderBy: { createdAt: 'desc' }, ...skipTake(query) }),
      this.prisma.priceList.count({ where }),
    ]);
    return toPage(items, total, query);
  }

  async createPriceList(org: ActingOrganization, dto: PriceListDto) {
    requireRole(org, CATALOG_ROLES, 'manage prices');
    requirePermission(org, 'prices:manage', 'change prices');
    await this.checkEntries(org, dto);
    return this.prisma.priceList.create({
      data: { ...this.header(org, dto), entries: { create: (dto.entries ?? []).map((e) => ({ variantId: e.variantId, minQuantity: e.minQuantity ?? '0', unitPrice: e.unitPrice })) } },
      include: { entries: true },
    });
  }

  async updatePriceList(org: ActingOrganization, priceListId: string, dto: PriceListDto) {
    requireRole(org, CATALOG_ROLES, 'manage prices');
    const list = await this.prisma.priceList.findFirst({ where: { id: priceListId, organizationId: org.organization.id } });
    if (!list) throw notFound('Price list');
    await this.checkEntries(org, dto);
    return this.prisma.$transaction(async (tx) => {
      await tx.priceList.update({ where: { id: list.id }, data: this.header(org, dto) });
      if (dto.entries) {
        await tx.priceListEntry.deleteMany({ where: { priceListId } });
        await tx.priceListEntry.createMany({ data: dto.entries.map((e) => ({ priceListId, variantId: e.variantId, minQuantity: e.minQuantity ?? '0', unitPrice: e.unitPrice })) });
      }
      return tx.priceList.findUniqueOrThrow({ where: { id: list.id }, include: { entries: true } });
    });
  }

  private header(org: ActingOrganization, dto: PriceListDto) {
    const startsAt = dto.startsAt ? new Date(dto.startsAt) : null;
    const endsAt = dto.endsAt ? new Date(dto.endsAt) : null;
    if (startsAt && endsAt && startsAt > endsAt) throw badRequest('invalid_dates', 'The price list must end after it starts');
    return {
      organizationId: org.organization.id,
      name: dto.name.trim(),
      currency: dto.currency,
      buyerOrganizationIds: dto.buyerOrganizationIds ?? [],
      branchId: dto.branchId ?? null,
      startsAt,
      endsAt,
      active: dto.active ?? true,
    };
  }

  private async checkEntries(org: ActingOrganization, dto: PriceListDto) {
    const ids = [...new Set((dto.entries ?? []).map((e) => e.variantId))];
    if (!ids.length) return;
    const found = await this.prisma.productVariant.findMany({ where: { id: { in: ids }, organizationId: org.organization.id }, select: { id: true, currency: true } });
    if (found.length !== ids.length) throw notFound('Variant');
    if (found.some((v) => v.currency !== dto.currency)) throw badRequest('currency_mismatch', 'Price list entries must be in the list currency');
  }

  // ---- Quote -------------------------------------------------------------------------------

  /** Server-side prices and product snapshots for order lines. Throws 422 with the first problem. */
  async quote(req: CatalogQuoteRequest): Promise<CatalogQuote> {
    if (req.supplierOrganizationId === req.buyerOrganizationId) throw badRequest('self_order', 'You cannot order from your own organization');
    const variantIds = [...new Set(req.lines.map((l) => l.variantId))];
    const variants = await this.prisma.productVariant.findMany({
      where: { id: { in: variantIds } },
      include: {
        priceTiers: true,
        product: {
          include: {
            category: true,
            media: { orderBy: { position: 'asc' }, take: 1 },
            optionGroups: { include: { options: true } },
          },
        },
      },
    });
    const byId = new Map(variants.map((v) => [v.id, v]));
    const now = new Date();
    const lists = await this.prisma.priceList.findMany({
      where: {
        organizationId: req.supplierOrganizationId,
        active: true,
        currency: req.currency,
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
          { OR: [{ buyerOrganizationIds: { isEmpty: true } }, { buyerOrganizationIds: { has: req.buyerOrganizationId } }] },
          { OR: [{ branchId: null }, ...(req.branchId ? [{ branchId: req.branchId }] : [])] },
        ],
      },
      include: { entries: { where: { variantId: { in: variantIds } } } },
    });

    const lines: CatalogQuoteLine[] = req.lines.map((line, i) => {
      const n = i + 1;
      const v = byId.get(line.variantId);
      const product = v?.product;
      if (!v || !product || product.status !== 'published' || !v.isActive) throw quoteError('unknown_variant', 'This product is not available', n);
      if (product.organizationId !== req.supplierOrganizationId) throw quoteError('wrong_supplier', 'The product belongs to another supplier', n);
      if (v.currency !== req.currency) throw quoteError('currency_mismatch', `The product is priced in ${v.currency}`, n);
      const quantity = new Decimal(line.quantity);
      if (quantity.lte(0)) throw quoteError('invalid_quantity', 'Quantity must be more than 0', n);
      if (v.minOrderQuantity && quantity.lt(v.minOrderQuantity)) {
        throw quoteError('below_moq', `The minimum order is ${v.minOrderQuantity.toString()} ${product.unitOfMeasure}`, n);
      }
      const season = availability(product, now);
      if (!season.orderable) throw quoteError('out_of_season', `${product.name} is out of season`, n);

      // Options: every picked option must belong to the product; required groups need a pick.
      const optionIds = new Set(line.optionIds ?? []);
      const picked: CatalogQuoteLine['snapshot']['options'] = [];
      let optionsTotal: Decimal = new Decimal(0);
      for (const g of product.optionGroups) {
        const chosen = g.options.filter((o) => optionIds.has(o.id));
        chosen.forEach((o) => optionIds.delete(o.id));
        if (chosen.some((o) => !o.isActive)) throw quoteError('unknown_option', `An option in "${g.name}" is no longer offered`, n);
        if (g.required && !chosen.length) throw quoteError('option_required', `Choose an option for "${g.name}"`, n);
        if (!g.multiple && chosen.length > 1) throw quoteError('one_option', `Choose one option for "${g.name}"`, n);
        for (const o of chosen) {
          picked.push({ groupName: g.name, optionId: o.id, name: o.name, priceDelta: o.priceDelta.toString() });
          optionsTotal = optionsTotal.plus(o.priceDelta);
        }
      }
      if (optionIds.size) throw quoteError('unknown_option', 'An option does not belong to this product', n);

      // Lowest applicable base price wins.
      const qty = quantity.toNumber();
      let base: Decimal = v.price;
      let priceSource: CatalogQuoteLine['priceSource'] = 'list';
      let priceListId: string | null = null;
      const tier = tierFor(v.priceTiers.map((t) => ({ ...t, minQuantity: t.minQuantity.toNumber(), unitPrice: t.unitPrice.toNumber(), price: t.unitPrice })), qty);
      if (tier && tier.price.lt(base)) {
        base = tier.price;
        priceSource = 'tier';
      }
      for (const list of lists) {
        const entry = tierFor(
          list.entries.filter((e) => e.variantId === v.id).map((e) => ({ minQuantity: e.minQuantity.toNumber(), unitPrice: e.unitPrice.toNumber(), price: e.unitPrice })),
          qty,
        );
        if (entry && entry.price.lt(base)) {
          base = entry.price;
          priceSource = 'price_list';
          priceListId = list.id;
        }
      }
      const unitPrice = base.plus(optionsTotal);
      const optionText = picked.length ? ` (${picked.map((o) => o.name).join(', ')})` : '';
      return {
        variantId: v.id,
        productId: product.id,
        description: `${product.name} — ${v.name}${optionText}`.slice(0, 500),
        quantity: quantity.toString(),
        unitOfMeasure: product.unitOfMeasure,
        unitPrice: unitPrice.toString(),
        listPrice: v.price.toString(),
        priceSource,
        priceListId,
        leadTimeDays: product.leadTimeDays,
        snapshot: {
          productId: product.id,
          productName: product.name,
          variantId: v.id,
          variantName: v.name,
          sku: v.sku,
          barcode: v.barcode,
          categorySlug: product.category.slug,
          unitOfMeasure: product.unitOfMeasure,
          attributes: product.attributes as Record<string, string>,
          variantAttributes: v.attributes as Record<string, string>,
          options: picked,
          imageDocumentId: product.media[0]?.documentId ?? null,
          packSize: v.packSize?.toString() ?? null,
          preorder: season.preorder,
          capturedAt: now.toISOString(),
        },
      };
    });
    if (!lines.length) throw conflict('empty_order', 'Add at least one line');
    const subtotal = lines.reduce((sum, l) => sum.plus(new Decimal(l.unitPrice).times(l.quantity)), new Decimal(0));
    return { currency: req.currency, lines, subtotal: subtotal.toDecimalPlaces(4).toString() };
  }
}
