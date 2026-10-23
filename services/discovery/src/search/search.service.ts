import { Injectable } from '@nestjs/common';
import { toPage, qualified } from '@uboce/common';

import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma.service.js';
import { toPrefixTsQuery } from './query.js';
import type { SearchProductsQueryDto, SearchSuppliersQueryDto } from './search.dto.js';

// Maintained by the indexer and GIN-indexed (see the schema).
const DOCUMENT = Prisma.sql`p.search_document`;

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

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
  supplier_name: string;
  supplier_country: string;
  supplier_verification: string;
  total: bigint;
}

@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  /** Only published products of active organizations are ever indexed or returned (PRD 5.6). */
  async searchProducts(q: SearchProductsQueryDto) {
    const tsQuery = toPrefixTsQuery(q.q);
    const where: Prisma.Sql[] = [Prisma.sql`o.status = 'active'`];
    if (tsQuery) where.push(Prisma.sql`${DOCUMENT} @@ to_tsquery('simple', ${tsQuery})`);
    if (q.category) where.push(Prisma.sql`p.category_slug = ${q.category}`);
    if (q.country) where.push(Prisma.sql`o.country_code = ${q.country}`);
    if (q.supplierId) where.push(Prisma.sql`p.organization_id = ${q.supplierId}::uuid`);
    if (q.currency) where.push(Prisma.sql`p.currency = ${q.currency}`);
    if (q.minPrice) where.push(Prisma.sql`p.max_price >= ${q.minPrice}::numeric`);
    if (q.maxPrice) where.push(Prisma.sql`p.min_price <= ${q.maxPrice}::numeric`);
    if (q.verifiedOnly) where.push(Prisma.sql`o.verification_status = 'verified'`);

    const order =
      q.sort === 'price_asc'
        ? Prisma.sql`p.min_price ASC, p.published_at DESC`
        : q.sort === 'price_desc'
          ? Prisma.sql`p.min_price DESC, p.published_at DESC`
          : q.sort === 'relevance' && tsQuery
            ? Prisma.sql`ts_rank(${DOCUMENT}, to_tsquery('simple', ${tsQuery})) DESC, p.published_at DESC`
            : Prisma.sql`p.published_at DESC`;

    const rows = await this.prisma.$queryRaw<ListingRow[]>`
      SELECT p.product_id, p.organization_id, p.name, p.description, p.category_slug, p.unit_of_measure,
             p.attributes, p.variants, p.min_price, p.max_price, p.currency, p.published_at,
             o.name AS supplier_name, o.country_code AS supplier_country, o.verification_status AS supplier_verification,
             count(*) OVER () AS total
      FROM ${Prisma.raw(qualified('product_listings'))} p
      JOIN ${Prisma.raw(qualified('organization_profiles'))} o ON o.organization_id = p.organization_id
      WHERE ${Prisma.join(where, ' AND ')}
      ORDER BY ${order}
      LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`;

    return toPage(
      rows.map((r) => ({
        productId: r.product_id,
        name: r.name,
        description: r.description,
        category: r.category_slug,
        unitOfMeasure: r.unit_of_measure,
        attributes: r.attributes,
        variants: r.variants,
        priceRange: { min: r.min_price.toFixed(2), max: r.max_price.toFixed(2), currency: r.currency },
        publishedAt: r.published_at,
        supplier: {
          organizationId: r.organization_id,
          name: r.supplier_name,
          countryCode: r.supplier_country,
          verified: r.supplier_verification === 'verified',
        },
      })),
      Number(rows[0]?.total ?? 0),
      q,
    );
  }

  /** Suppliers with at least one live product. */
  async searchSuppliers(q: SearchSuppliersQueryDto) {
    const where: Prisma.Sql[] = [Prisma.sql`o.status = 'active'`];
    if (q.q) where.push(Prisma.sql`o.name ILIKE ${`%${escapeLike(q.q)}%`}`);
    if (q.country) where.push(Prisma.sql`o.country_code = ${q.country}`);
    if (q.type) where.push(Prisma.sql`o.type = ${q.type}`);

    const rows = await this.prisma.$queryRaw<
      { organization_id: string; name: string; type: string; country_code: string; verification_status: string; products: bigint; total: bigint }[]
    >`
      SELECT o.organization_id, o.name, o.type, o.country_code, o.verification_status,
             count(p.product_id) AS products, count(*) OVER () AS total
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
