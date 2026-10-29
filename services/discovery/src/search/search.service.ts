import { Injectable } from '@nestjs/common';
import { dbSchema, qualified, toPage } from '@uboce/common';

import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma.service.js';
import { parseAttributeFilters, similarityText, toPrefixTsQuery } from './query.js';
import type { SearchProductsQueryDto, SearchSuppliersQueryDto } from './search.dto.js';

// Maintained by the indexer and GIN-indexed (see the schema).
const DOCUMENT = Prisma.sql`p.search_document`;
/** Trigram similarity at or above this counts as a (typo-tolerant) match. */
const SIMILARITY_THRESHOLD = 0.4;

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
/** pg_trgm lives in this service's schema; qualify it, since pooled connections have no search_path. */
const trgm = (fn: string) => Prisma.raw(`"${dbSchema()}".${fn}`);

interface ListingRow {
  product_id: string;
  organization_id: string;
  name: string;
  description: string | null;
  category_slug: string;
  unit_of_measure: string;
  attributes: unknown;
  variants: unknown;
  min_price: Prisma.Decimal;
  max_price: Prisma.Decimal;
  currency: string;
  published_at: Date;
  min_order_quantity: Prisma.Decimal | null;
  image_document_id: string | null;
  available_from: Date | null;
  available_until: Date | null;
  allow_preorder: boolean;
  made_to_order: boolean;
  in_stock: boolean;
  supplier_name: string;
  supplier_country: string;
  supplier_verification: string;
  rating_sum: number;
  rating_count: number;
  total: bigint;
}

@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  /** The WHERE clause shared by results and facets. */
  private productFilters(q: SearchProductsQueryDto) {
    const tsQuery = toPrefixTsQuery(q.q);
    const simText = similarityText(q.q);
    const similarity = simText ? Prisma.sql`${trgm('word_similarity')}(${simText}, coalesce(p.search_text, ''))` : null;
    const where: Prisma.Sql[] = [Prisma.sql`o.status = 'active'`];
    if (tsQuery && similarity) where.push(Prisma.sql`(${DOCUMENT} @@ to_tsquery('simple', ${tsQuery}) OR ${similarity} >= ${SIMILARITY_THRESHOLD})`);
    if (q.category) where.push(Prisma.sql`(p.category_slug = ${q.category} OR ${q.category} = ANY (p.category_path))`);
    if (q.supplierType) where.push(Prisma.sql`o.type = ANY (${q.supplierType.split(',')})`);
    if (q.country) where.push(Prisma.sql`o.country_code = ${q.country}`);
    if (q.supplierId) where.push(Prisma.sql`p.organization_id = ${q.supplierId}::uuid`);
    if (q.currency) where.push(Prisma.sql`p.currency = ${q.currency}`);
    if (q.minPrice) where.push(Prisma.sql`p.max_price >= ${q.minPrice}::numeric`);
    if (q.maxPrice) where.push(Prisma.sql`p.min_price <= ${q.maxPrice}::numeric`);
    if (q.verifiedOnly) where.push(Prisma.sql`o.verification_status = 'verified'`);
    // PRD addendum 2.11 filters.
    if (q.maxMoq) where.push(Prisma.sql`(p.min_order_quantity IS NULL OR p.min_order_quantity <= ${q.maxMoq}::numeric)`);
    if (q.inStock) {
      where.push(Prisma.sql`(p.made_to_order OR EXISTS (SELECT 1 FROM ${Prisma.raw(qualified('product_stock'))} s
        WHERE s.organization_id = p.organization_id AND s.item_id = p.product_id AND s.on_hand > 0))`);
    }
    if (q.minRating) where.push(Prisma.sql`(o.rating_count > 0 AND o.rating_sum::numeric / o.rating_count >= ${q.minRating}::numeric)`);
    if (q.deliversTo) {
      where.push(Prisma.sql`(lower(${q.deliversTo}) = ANY (SELECT lower(a) FROM unnest(o.service_areas || o.pickup_cities) a))`);
    }
    if (q.madeToOrder !== undefined) where.push(Prisma.sql`p.made_to_order = ${q.madeToOrder}`);
    const inSeason = Prisma.sql`((p.available_from IS NULL OR p.available_from <= now()) AND (p.available_until IS NULL OR p.available_until >= now()))`;
    const preorder = Prisma.sql`(p.allow_preorder AND p.available_from > now())`;
    if (q.availability === 'in_season') where.push(inSeason);
    else if (q.availability === 'preorder') where.push(preorder);
    else where.push(Prisma.sql`(${inSeason} OR ${preorder})`);
    for (const [key, value] of parseAttributeFilters(q.attributes)) where.push(Prisma.sql`lower(p.attributes ->> ${key}) = lower(${value})`);
    return { where, tsQuery, similarity };
  }

  /** Only published products of active organizations are ever indexed or returned (PRD 5.6). */
  async searchProducts(q: SearchProductsQueryDto) {
    const { where, tsQuery, similarity } = this.productFilters(q);
    const relevance =
      tsQuery && similarity ? Prisma.sql`GREATEST(ts_rank(${DOCUMENT}, to_tsquery('simple', ${tsQuery})), ${similarity} * 0.5)` : Prisma.sql`0`;
    const order =
      q.sort === 'price_asc'
        ? Prisma.sql`p.min_price ASC, p.published_at DESC`
        : q.sort === 'price_desc'
          ? Prisma.sql`p.min_price DESC, p.published_at DESC`
          : q.sort === 'rating'
            ? Prisma.sql`(CASE WHEN o.rating_count > 0 THEN o.rating_sum::numeric / o.rating_count ELSE 0 END) DESC, o.rating_count DESC, p.published_at DESC`
            : q.sort === 'relevance' && tsQuery
              ? Prisma.sql`${relevance} DESC, p.published_at DESC`
              : Prisma.sql`p.published_at DESC`;

    const rows = await this.prisma.$queryRaw<ListingRow[]>`
      SELECT p.product_id, p.organization_id, p.name, p.description, p.category_slug, p.unit_of_measure,
             p.attributes, p.variants, p.min_price, p.max_price, p.currency, p.published_at,
             p.min_order_quantity, p.image_document_id, p.available_from, p.available_until, p.allow_preorder, p.made_to_order,
             (p.made_to_order OR EXISTS (SELECT 1 FROM ${Prisma.raw(qualified('product_stock'))} s
               WHERE s.organization_id = p.organization_id AND s.item_id = p.product_id AND s.on_hand > 0)) AS in_stock,
             o.name AS supplier_name, o.country_code AS supplier_country, o.verification_status AS supplier_verification,
             o.rating_sum, o.rating_count,
             count(*) OVER () AS total
      FROM ${Prisma.raw(qualified('product_listings'))} p
      JOIN ${Prisma.raw(qualified('organization_profiles'))} o ON o.organization_id = p.organization_id
      WHERE ${Prisma.join(where, ' AND ')}
      ORDER BY ${order}
      LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`;

    const page = toPage(
      rows.map((r) => {
        const now = Date.now();
        const preorder = Boolean(r.allow_preorder && r.available_from && r.available_from.getTime() > now);
        return {
          productId: r.product_id,
          name: r.name,
          description: r.description,
          category: r.category_slug,
          unitOfMeasure: r.unit_of_measure,
          attributes: r.attributes,
          variants: r.variants,
          priceRange: { min: r.min_price.toFixed(2), max: r.max_price.toFixed(2), currency: r.currency },
          publishedAt: r.published_at,
          minOrderQuantity: r.min_order_quantity?.toString() ?? null,
          imageUrl: r.image_document_id ? `/api/v1/documents/public/${r.image_document_id}` : null,
          availability: { from: r.available_from, until: r.available_until, preorder, madeToOrder: r.made_to_order, inStock: r.in_stock },
          supplier: {
            organizationId: r.organization_id,
            name: r.supplier_name,
            countryCode: r.supplier_country,
            verified: r.supplier_verification === 'verified',
            rating: r.rating_count ? { average: Math.round((r.rating_sum / r.rating_count) * 100) / 100, count: r.rating_count } : null,
          },
        };
      }),
      Number(rows[0]?.total ?? 0),
      q,
    );
    return q.facets ? { ...page, facets: await this.facets(q) } : page;
  }

  /** Counts for refining the current search: categories, countries, verified suppliers, attribute values, price span. */
  private async facets(q: SearchProductsQueryDto) {
    const { where } = this.productFilters(q);
    const from = Prisma.sql`FROM ${Prisma.raw(qualified('product_listings'))} p JOIN ${Prisma.raw(qualified('organization_profiles'))} o ON o.organization_id = p.organization_id WHERE ${Prisma.join(where, ' AND ')}`;
    const [categories, countries, verified, attributeRows, price, sectors, supplierTypes] = await Promise.all([
      this.prisma.$queryRaw<{ value: string; count: bigint }[]>`SELECT p.category_slug AS value, count(*) AS count ${from} GROUP BY 1 ORDER BY 2 DESC LIMIT 30`,
      this.prisma.$queryRaw<{ value: string; count: bigint }[]>`SELECT o.country_code AS value, count(*) AS count ${from} GROUP BY 1 ORDER BY 2 DESC LIMIT 30`,
      this.prisma.$queryRaw<{ count: bigint }[]>`SELECT count(*) AS count ${from} AND o.verification_status = 'verified'`,
      this.prisma.$queryRaw<{ key: string; value: string; count: bigint }[]>`
        SELECT a.key, a.value, count(*) AS count
        FROM ${Prisma.raw(qualified('product_listings'))} p
        JOIN ${Prisma.raw(qualified('organization_profiles'))} o ON o.organization_id = p.organization_id
        CROSS JOIN LATERAL jsonb_each_text(p.attributes) a
        WHERE ${Prisma.join(where, ' AND ')}
        GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 80`,
      this.prisma.$queryRaw<{ min: Prisma.Decimal | null; max: Prisma.Decimal | null }[]>`SELECT min(p.min_price) AS min, max(p.max_price) AS max ${from}`,
      this.prisma.$queryRaw<{ value: string; count: bigint }[]>`SELECT coalesce(p.category_path[1], p.category_slug) AS value, count(*) AS count ${from} GROUP BY 1 ORDER BY 2 DESC LIMIT 30`,
      this.prisma.$queryRaw<{ value: string; count: bigint }[]>`SELECT o.type AS value, count(*) AS count ${from} GROUP BY 1 ORDER BY 2 DESC LIMIT 20`,
    ]);
    const byKey: Record<string, { value: string; count: number }[]> = {};
    for (const r of attributeRows) (byKey[r.key] ??= []).push({ value: r.value, count: Number(r.count) });
    const n = (rows: { value: string; count: bigint }[]) => rows.map((r) => ({ value: r.value, count: Number(r.count) }));
    return {
      categories: n(categories),
      sectors: n(sectors),
      supplierTypes: n(supplierTypes),
      countries: n(countries),
      verifiedSuppliers: Number(verified[0]?.count ?? 0),
      attributes: byKey,
      price: { min: price[0]?.min?.toFixed(2) ?? null, max: price[0]?.max?.toFixed(2) ?? null },
    };
  }

  /** Suppliers with at least one live product. */
  async searchSuppliers(q: SearchSuppliersQueryDto) {
    const where: Prisma.Sql[] = [Prisma.sql`o.status = 'active'`];
    if (q.q) {
      const text = similarityText(q.q);
      where.push(Prisma.sql`(o.name ILIKE ${`%${escapeLike(q.q)}%`} OR ${trgm('word_similarity')}(${text}, lower(o.name)) >= ${SIMILARITY_THRESHOLD})`);
    }
    if (q.country) where.push(Prisma.sql`o.country_code = ${q.country}`);
    if (q.type) where.push(Prisma.sql`o.type = ${q.type}`);
    if (q.minRating) where.push(Prisma.sql`(o.rating_count > 0 AND o.rating_sum::numeric / o.rating_count >= ${q.minRating}::numeric)`);
    if (q.deliversTo) where.push(Prisma.sql`(lower(${q.deliversTo}) = ANY (SELECT lower(a) FROM unnest(o.service_areas || o.pickup_cities) a))`);
    if (q.verifiedOnly) where.push(Prisma.sql`o.verification_status = 'verified'`);

    const rows = await this.prisma.$queryRaw<
      {
        organization_id: string;
        name: string;
        type: string;
        country_code: string;
        verification_status: string;
        rating_sum: number;
        rating_count: number;
        service_areas: string[];
        pickup_cities: string[];
        products: bigint;
        total: bigint;
      }[]
    >`
      SELECT o.organization_id, o.name, o.type, o.country_code, o.verification_status, o.rating_sum, o.rating_count,
             o.service_areas, o.pickup_cities, count(p.product_id) AS products, count(*) OVER () AS total
      FROM ${Prisma.raw(qualified('organization_profiles'))} o
      JOIN ${Prisma.raw(qualified('product_listings'))} p ON p.organization_id = o.organization_id
      WHERE ${Prisma.join(where, ' AND ')}
      GROUP BY o.organization_id
      ORDER BY products DESC, o.name ASC
      LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`;

    return toPage(
      rows.map((r) => ({
        organizationId: r.organization_id,
        name: r.name,
        type: r.type,
        countryCode: r.country_code,
        verified: r.verification_status === 'verified',
        productCount: Number(r.products),
        rating: r.rating_count ? { average: Math.round((r.rating_sum / r.rating_count) * 100) / 100, count: r.rating_count } : null,
        serviceAreas: r.service_areas,
        pickupCities: r.pickup_cities,
      })),
      Number(rows[0]?.total ?? 0),
      q,
    );
  }

  async status() {
    const [state, listings] = await Promise.all([
      this.prisma.indexState.findUnique({ where: { id: 'search' } }),
      this.prisma.productListing.count(),
    ]);
    return {
      listings,
      lastIndexedAt: state?.lastIndexedAt ?? null,
      lastEventOccurredAt: state?.lastEventOccurredAt ?? null,
      /** How far behind the source the newest applied change was when it landed. */
      lastLagMs: state ? state.lastIndexedAt.getTime() - state.lastEventOccurredAt.getTime() : null,
    };
  }
}
