import { Inject, Injectable, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { handleOnce, REDIS, StreamConsumer, qualified } from '@uboce/common';
import type { DomainEvent, EventEnvelope, EventType, ProductPublishedV1 } from '@uboce/contracts';
import type { Redis } from 'ioredis';

import { SERVICE_NAME } from '../config.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma.service.js';

type Tx = Prisma.TransactionClient;

/** Price range in the listing's currency (the first variant's; mixed-currency products filter on that one). */
export function priceRange(variants: ProductPublishedV1['variants']) {
  const currency = variants[0]?.currency;
  if (!currency) return null;
  const prices = variants.filter((v) => v.currency === currency).map((v) => new Prisma.Decimal(v.price));
  return {
    currency,
    min: prices.reduce((a, b) => (b.lessThan(a) ? b : a)),
    max: prices.reduce((a, b) => (b.greaterThan(a) ? b : a)),
  };
}

/** The smallest minimum order across variants; null when any variant has none. */
export function minMoq(variants: ProductPublishedV1['variants']) {
  const moqs = variants.map((v) => v.minOrderQuantity);
  if (!moqs.length || moqs.some((m) => !m)) return null;
  return moqs.map((m) => new Prisma.Decimal(m!)).reduce((a, b) => (b.lessThan(a) ? b : a));
}

/** Keeps the search read models in step with Catalog and Organization events. */
@Injectable()
export class SearchIndexer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly consumer: StreamConsumer;

  constructor(
    @Inject(REDIS) redis: Redis,
    private readonly prisma: PrismaService,
  ) {
    this.consumer = new StreamConsumer(redis, {
      group: SERVICE_NAME,
      handlers: {
        ProductPublished: this.on('ProductPublished', (e, tx) => this.indexProduct(e, tx)),
        ProductArchived: this.on('ProductArchived', async (e, tx) => {
          await tx.productListing.deleteMany({
            where: { productId: e.data.productId, sourceOccurredAt: { lte: new Date(e.occurredAt) } },
          });
        }),
        OrganizationCreated: this.on('OrganizationCreated', (e, tx) =>
          this.upsertOrganization(tx, e.occurredAt, {
            organizationId: e.data.organizationId,
            name: e.data.name,
            type: e.data.type,
            countryCode: e.data.countryCode,
            status: 'active',
            verificationStatus: 'unverified',
          }),
        ),
        OrganizationUpdated: this.on('OrganizationUpdated', (e, tx) => this.upsertOrganization(tx, e.occurredAt, e.data)),
        // PRD addendum 2.11: delivery areas, ratings and stock for search filters.
        OrganizationLocationsChanged: this.on('OrganizationLocationsChanged', async (e, tx) => {
          await tx.organizationProfile.updateMany({
            where: { organizationId: e.data.organizationId },
            data: { serviceAreas: e.data.serviceAreas, pickupCities: e.data.pickupCities },
          });
        }),
        ReviewPublished: this.on('ReviewPublished', async (e, tx) => {
          if (e.data.productId) return; // business ratings only
          await tx.organizationProfile.updateMany({
            where: { organizationId: e.data.subjectOrganizationId },
            data: { ratingSum: { increment: e.data.rating }, ratingCount: { increment: 1 } },
          });
        }),
        StockMovementPosted: this.on('StockMovementPosted', async (e, tx) => {
          await tx.$executeRaw`INSERT INTO ${Prisma.raw(qualified('product_stock'))} (organization_id, item_id, on_hand, updated_at)
            VALUES (${e.data.organizationId}::uuid, ${e.data.itemId}::uuid, ${e.data.quantity}::numeric, now())
            ON CONFLICT (organization_id, item_id) DO UPDATE SET on_hand = product_stock.on_hand + EXCLUDED.on_hand, updated_at = now()`;
        }),
      },
    });
  }

  async onApplicationBootstrap() {
    await this.consumer.start();
  }

  async beforeApplicationShutdown() {
    await this.consumer.stop();
  }

  private async indexProduct(e: DomainEvent<'ProductPublished'>, tx: Tx) {
    const occurredAt = new Date(e.occurredAt);
    const existing = await tx.productListing.findUnique({ where: { productId: e.data.productId } });
    if (existing && existing.sourceOccurredAt > occurredAt) return; // a newer snapshot already won

    const range = priceRange(e.data.variants);
    if (!range) {
      await tx.productListing.deleteMany({ where: { productId: e.data.productId } });
      return;
    }
    const row = {
      organizationId: e.data.organizationId,
      name: e.data.name,
      description: e.data.description,
      categoryId: e.data.categoryId,
      categorySlug: e.data.categorySlug,
      categoryPath: e.data.categoryPath ?? [e.data.categorySlug],
      unitOfMeasure: e.data.unitOfMeasure,
      attributes: e.data.attributes,
      variants: e.data.variants as unknown as Prisma.InputJsonValue,
      minPrice: range.min,
      maxPrice: range.max,
      currency: range.currency,
      publishedAt: new Date(e.data.publishedAt),
      sourceOccurredAt: occurredAt,
      minOrderQuantity: minMoq(e.data.variants),
      imageDocumentId: e.data.imageDocumentId ?? null,
      availableFrom: e.data.availableFrom ? new Date(e.data.availableFrom) : null,
      availableUntil: e.data.availableUntil ? new Date(e.data.availableUntil) : null,
      allowPreorder: e.data.allowPreorder ?? false,
      madeToOrder: e.data.madeToOrder ?? false,
    };
    await tx.productListing.upsert({ where: { productId: e.data.productId }, update: row, create: { productId: e.data.productId, ...row } });
    // Searchable text: name, description, category and attribute values (e.g. "Yirgacheffe").
    const text = [e.data.name, e.data.description ?? '', e.data.categorySlug, ...Object.values(e.data.attributes)].join(' ');
    await tx.$executeRaw`UPDATE ${Prisma.raw(qualified('product_listings'))} SET search_document = to_tsvector('simple', ${text}), search_text = lower(${text}) WHERE product_id = ${e.data.productId}::uuid`;
  }

  private async upsertOrganization(
    tx: Tx,
    occurredAtIso: string,
    data: { organizationId: string; name: string; type: string; countryCode: string; status: string; verificationStatus: string },
  ) {
    const occurredAt = new Date(occurredAtIso);
    const existing = await tx.organizationProfile.findUnique({ where: { organizationId: data.organizationId } });
    if (existing && existing.sourceOccurredAt > occurredAt) return;
    const { organizationId, ...row } = data;
    await tx.organizationProfile.upsert({
      where: { organizationId },
      update: { ...row, sourceOccurredAt: occurredAt },
      create: { organizationId, ...row, sourceOccurredAt: occurredAt },
    });
  }

  private on<T extends EventType>(_type: T, apply: (event: DomainEvent<T>, tx: Tx) => Promise<void>) {
    return async (event: EventEnvelope) => {
      await handleOnce<Tx>(this.prisma, event, async (tx) => {
        await apply(event as DomainEvent<T>, tx);
        const state = { lastEventId: event.eventId, lastEventOccurredAt: new Date(event.occurredAt), lastIndexedAt: new Date() };
        await tx.indexState.upsert({ where: { id: 'search' }, update: state, create: { id: 'search', ...state } });
      });
    };
  }
}
