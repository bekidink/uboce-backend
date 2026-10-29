import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type ActingOrganization,
  AppError,
  badRequest,
  buildEvent,
  conflict,
  DocumentsClient,
  forbidden,
  GroqClient,
  notFound,
  requireRole,
  skipTake,
  toOutboxRow,
  toPage,
} from '@uboce/common';

import { SERVICE_NAME } from '../config.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma.service.js';
import type {
  CreateProductDto,
  ListProductsQueryDto,
  ProductAvailabilityDto,
  ProductMediaDto,
  ProductOptionsDto,
  UpdateProductDto,
  UpdateVariantDto,
  VariantDto,
} from './catalog.dto.js';
import { z } from 'zod';

import { categoryPath } from './categories.js';
import { type AttributeDefinition, attributeTypeProblems, normalizeAttributes, publicationProblems } from './publishing.js';

const DescriptionSchema = z.object({ description: z.string().min(20).max(1500), highlights: z.array(z.string().max(120)).max(5).optional() });

type Tx = Prisma.TransactionClient;

/** Roles that may manage their organization's catalog (PRD 3.1: sales reps, producers). */
export const CATALOG_ROLES = ['owner', 'admin', 'sales_representative', 'manufacturer', 'farmer'];

export const productInclude = {
  variants: { orderBy: { createdAt: 'asc' }, include: { priceTiers: { orderBy: { minQuantity: 'asc' } } } },
  category: true,
  media: { orderBy: { position: 'asc' } },
  optionGroups: { orderBy: { position: 'asc' }, include: { options: { orderBy: { position: 'asc' } } } },
} as const;
type ProductWithVariants = Prisma.ProductGetPayload<{ include: typeof productInclude }>;

const definitionsOf = (category: { attributeDefinitions: unknown }) => (category.attributeDefinitions ?? []) as AttributeDefinition[];

/** Normalizes values and rejects ones that don't fit the category's typed attributes. */
const attributes = (input: Record<string, unknown> | undefined, definitions: AttributeDefinition[] = []) => {
  let values: Record<string, string>;
  try {
    values = normalizeAttributes(input);
  } catch (error) {
    throw badRequest('invalid_attributes', (error as Error).message);
  }
  const problems = attributeTypeProblems(values, definitions);
  if (problems.length) throw new AppError(HttpStatus.BAD_REQUEST, 'invalid_attributes', problems.join('; '), problems);
  return values;
};

const skuTaken = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
    ? conflict('sku_taken', 'Another product in your organization already uses this SKU')
    : error;

const dateOrNull = (v: string | null | undefined) => (v === undefined ? undefined : v === null ? null : new Date(v));

/** Availability fields from a create/update request (undefined leaves a field unchanged). */
const availabilityData = (dto: ProductAvailabilityDto) => {
  const data = {
    availableFrom: dateOrNull(dto.availableFrom),
    availableUntil: dateOrNull(dto.availableUntil),
    allowPreorder: dto.allowPreorder,
    madeToOrder: dto.madeToOrder,
    leadTimeDays: dto.leadTimeDays,
  };
  if (data.availableFrom && data.availableUntil && data.availableFrom > data.availableUntil) {
    throw badRequest('invalid_season', 'The season must end after it starts');
  }
  return data;
};

const variantExtras = (v: VariantDto | UpdateVariantDto) => ({
  barcode: v.barcode,
  packSize: v.packSize,
  tracksBatches: v.tracksBatches,
  tracksExpiry: v.tracksExpiry,
  shelfLifeDays: v.shelfLifeDays,
});

@Injectable()
export class CatalogService {
  private readonly ai = new GroqClient();

  constructor(
    private readonly prisma: PrismaService,
    private readonly documents: DocumentsClient,
  ) {}

  listCategories() {
    return this.prisma.category.findMany({ where: { organizationId: null }, orderBy: [{ parentId: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }] });
  }

  async create(org: ActingOrganization, userId: string, dto: CreateProductDto) {
    requireRole(org, CATALOG_ROLES, 'manage the catalog');
    const category = await this.category(dto.categoryId, org.organization.id);
    const organizationId = org.organization.id;
    try {
      return await this.prisma.product.create({
        data: {
          organizationId,
          name: dto.name.trim(),
          description: dto.description?.trim() || null,
          categoryId: dto.categoryId,
          unitOfMeasure: dto.unitOfMeasure,
          attributes: attributes(dto.attributes, definitionsOf(category)),
          ...availabilityData(dto),
          createdByUserId: userId,
          variants: { create: (dto.variants ?? []).map((v) => this.variantData(organizationId, v)) },
        },
        include: productInclude,
      });
    } catch (error) {
      throw skuTaken(error);
    }
  }

  async list(org: ActingOrganization, query: ListProductsQueryDto) {
    const where: Prisma.ProductWhereInput = { organizationId: org.organization.id, ...(query.status ? { status: query.status } : {}) };
    const [items, total] = await Promise.all([
      this.prisma.product.findMany({ where, include: productInclude, orderBy: { updatedAt: 'desc' }, ...skipTake(query) }),
      this.prisma.product.count({ where }),
    ]);
    return toPage(items, total, query);
  }

  get(org: ActingOrganization, productId: string) {
    return this.owned(org, productId);
  }

  /** Published products are visible to every signed-in user; drafts never are. */
  async getPublished(productId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, status: 'published' },
      include: {
        ...productInclude,
        variants: { where: { isActive: true }, orderBy: { createdAt: 'asc' }, include: { priceTiers: { orderBy: { minQuantity: 'asc' } } } },
        optionGroups: { orderBy: { position: 'asc' }, include: { options: { where: { isActive: true }, orderBy: { position: 'asc' } } } },
      },
    });
    if (!product) throw notFound('Product');
    return product;
  }

  async update(org: ActingOrganization, productId: string, dto: UpdateProductDto) {
    requireRole(org, CATALOG_ROLES, 'manage the catalog');
    const product = await this.owned(org, productId);
    if (product.status === 'archived') throw conflict('product_archived', 'Archived products cannot be changed');
    const category = dto.categoryId ? await this.category(dto.categoryId, org.organization.id) : product.category;

    return this.prisma.$transaction(async (tx) => {
      await tx.product.update({
        where: { id: productId },
        data: {
          name: dto.name?.trim(),
          description: dto.description === undefined ? undefined : dto.description.trim() || null,
          categoryId: dto.categoryId,
          unitOfMeasure: dto.unitOfMeasure,
          attributes: dto.attributes ? attributes(dto.attributes, definitionsOf(category)) : undefined,
          ...availabilityData(dto),
        },
      });
      return this.afterChange(tx, productId);
    });
  }

  async addVariant(org: ActingOrganization, productId: string, dto: VariantDto) {
    requireRole(org, CATALOG_ROLES, 'manage the catalog');
    const product = await this.owned(org, productId);
    if (product.status === 'archived') throw conflict('product_archived', 'Archived products cannot be changed');
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.productVariant.create({ data: { ...this.variantData(org.organization.id, dto), productId } });
        return this.afterChange(tx, productId);
      });
    } catch (error) {
      throw skuTaken(error);
    }
  }

  async updateVariant(org: ActingOrganization, productId: string, variantId: string, dto: UpdateVariantDto) {
    requireRole(org, CATALOG_ROLES, 'manage the catalog');
    const product = await this.owned(org, productId);
    if (!product.variants.some((v) => v.id === variantId)) throw notFound('Variant');
    return this.prisma.$transaction(async (tx) => {
      await tx.productVariant.update({
        where: { id: variantId },
        data: { name: dto.name?.trim(), price: dto.price, minOrderQuantity: dto.minOrderQuantity, isActive: dto.isActive, ...variantExtras(dto) },
      });
      const updated = await this.afterChange(tx, productId);
      if (updated.status === 'published' && !updated.variants.some((v) => v.isActive)) {
        throw conflict('last_active_variant', 'A published product needs at least one active variant; archive it instead');
      }
      return updated;
    });
  }

  /** A buyer-facing description written from the product's own data. */
  async suggestDescription(org: ActingOrganization, productId: string) {
    requireRole(org, CATALOG_ROLES, 'manage the catalog');
    const p = await this.owned(org, productId);
    const defs = definitionsOf(p.category);
    const result = await this.ai.json({
      system: `You write concise, factual B2B product descriptions for an Ethiopian marketplace (buyers are businesses).
Use only the facts given (name, category, attributes, variants, minimum orders). No superlatives you can't support, no prices.
Return {"description": 2–4 sentences, "highlights": up to 5 short bullet phrases}.`,
      user: JSON.stringify({
        name: p.name,
        category: p.category.name,
        unit: p.unitOfMeasure,
        attributes: Object.entries(p.attributes as Record<string, string>).map(([k, v]) => `${defs.find((d) => d.key === k)?.label ?? k}: ${v}${defs.find((d) => d.key === k)?.unit ?? ''}`),
        variants: p.variants.map((v) => ({ name: v.name, minimumOrder: v.minOrderQuantity?.toString() ?? null })),
        madeToOrder: p.madeToOrder,
        leadTimeDays: p.leadTimeDays,
      }),
      schema: DescriptionSchema,
    });
    return { ...result, generatedBy: this.ai.modelName };
  }

  /** Replaces the product's images, in display order (the first is primary). Images become publicly viewable. */
  async setMedia(org: ActingOrganization, productId: string, dto: ProductMediaDto) {
    requireRole(org, CATALOG_ROLES, 'manage the catalog');
    const product = await this.owned(org, productId);
    if (product.status === 'archived') throw conflict('product_archived', 'Archived products cannot be changed');
    const ids = dto.items.map((i) => i.documentId);
    if (new Set(ids).size !== ids.length) throw badRequest('duplicate_media', 'Each image can be used once');
    const known = new Set(product.media.map((m) => m.documentId));
    for (const id of ids.filter((d) => !known.has(d))) {
      const published = await this.documents.publish(id).catch(() => null);
      if (!published) throw badRequest('invalid_image', 'Upload the image as a product_image document first');
      if (published.ownerOrganizationId !== org.organization.id) throw forbidden('Use images uploaded by your organization');
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.productMedia.deleteMany({ where: { productId } });
      await tx.productMedia.createMany({
        data: dto.items.map((item, position) => ({ productId, documentId: item.documentId, position, altText: item.altText?.trim() || null })),
      });
      return this.afterChange(tx, productId);
    });
  }

  /** Replaces the product's option groups (add-ons, choices). Past orders keep their own snapshot. */
  async setOptions(org: ActingOrganization, productId: string, dto: ProductOptionsDto) {
    requireRole(org, CATALOG_ROLES, 'manage the catalog');
    const product = await this.owned(org, productId);
    if (product.status === 'archived') throw conflict('product_archived', 'Archived products cannot be changed');
    return this.prisma.$transaction(async (tx) => {
      await tx.productOptionGroup.deleteMany({ where: { productId } });
      for (const [position, g] of dto.groups.entries()) {
        await tx.productOptionGroup.create({
          data: {
            productId,
            name: g.name.trim(),
            required: g.required ?? false,
            multiple: g.multiple ?? false,
            position,
            options: { create: g.options.map((o, i) => ({ name: o.name.trim(), priceDelta: o.priceDelta ?? '0', position: i })) },
          },
        });
      }
      return this.afterChange(tx, productId);
    });
  }

  async publish(org: ActingOrganization, productId: string) {
    requireRole(org, CATALOG_ROLES, 'publish products');
    const product = await this.owned(org, productId);
    if (product.status === 'published') return product;
    if (product.status === 'archived') throw conflict('product_archived', 'Archived products cannot be republished');
    const problems = publicationProblems(
      { attributes: product.attributes as Record<string, string>, variants: product.variants },
      product.category.requiredAttributes,
      definitionsOf(product.category),
    );
    if (problems.length) throw new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'not_publishable', 'Product is not ready to publish', problems);

    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.product.updateMany({
        where: { id: productId, status: 'draft' },
        data: { status: 'published', publishedAt: new Date() },
      });
      if (count === 0) throw conflict('concurrent_change', 'The product changed; reload and try again');
      return this.afterChange(tx, productId);
    });
  }

  async archive(org: ActingOrganization, productId: string) {
    requireRole(org, CATALOG_ROLES, 'manage the catalog');
    const product = await this.owned(org, productId);
    if (product.status === 'archived') return product;
    return this.prisma.$transaction(async (tx) => {
      const archived = await tx.product.update({ where: { id: productId }, data: { status: 'archived' }, include: productInclude });
      if (product.status === 'published') {
        await tx.outboxEvent.create({
          data: toOutboxRow(buildEvent(SERVICE_NAME, 'ProductArchived', productId, { productId, organizationId: product.organizationId })),
        });
      }
      return archived;
    });
  }

  /** Re-reads the product and, if it's live, publishes the new snapshot for search. */
  async afterChange(tx: Tx, productId: string): Promise<ProductWithVariants> {
    const product = await tx.product.findUniqueOrThrow({ where: { id: productId }, include: productInclude });
    if (product.status === 'published') {
      await tx.outboxEvent.create({
        data: toOutboxRow(
          buildEvent(SERVICE_NAME, 'ProductPublished', product.id, {
            productId: product.id,
            organizationId: product.organizationId,
            name: product.name,
            description: product.description,
            categoryId: product.categoryId,
            categorySlug: product.category.slug,
            categoryPath: await categoryPath(tx, product.categoryId),
            unitOfMeasure: product.unitOfMeasure,
            attributes: product.attributes as Record<string, string>,
            variants: product.variants
              .filter((v) => v.isActive)
              .map((v) => ({
                variantId: v.id,
                sku: v.sku,
                name: v.name,
                price: v.price.toFixed(2),
                currency: v.currency,
                attributes: v.attributes as Record<string, string>,
                minOrderQuantity: v.minOrderQuantity?.toString() ?? null,
                lowestTierPrice: v.priceTiers.length ? Prisma.Decimal.min(...v.priceTiers.map((t) => t.unitPrice)).toFixed(2) : null,
              })),
            publishedAt: (product.publishedAt ?? new Date()).toISOString(),
            imageDocumentId: product.media[0]?.documentId ?? null,
            availableFrom: product.availableFrom?.toISOString() ?? null,
            availableUntil: product.availableUntil?.toISOString() ?? null,
            allowPreorder: product.allowPreorder,
            madeToOrder: product.madeToOrder,
          }),
        ),
      });
    }
    return product;
  }

  /** Other organizations' products look like they don't exist. */
  async owned(org: ActingOrganization, productId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, organizationId: org.organization.id },
      include: productInclude,
    });
    if (!product) throw notFound('Product');
    return product;
  }

  /** A platform category or one of the organization's own. */
  private async category(categoryId: string, organizationId: string) {
    const category = await this.prisma.category.findFirst({ where: { id: categoryId, OR: [{ organizationId: null }, { organizationId }] } });
    if (!category) throw badRequest('unknown_category', 'Category does not exist');
    return category;
  }

  private variantData(organizationId: string, v: VariantDto) {
    return {
      organizationId,
      sku: v.sku,
      name: v.name.trim(),
      price: v.price,
      currency: v.currency,
      minOrderQuantity: v.minOrderQuantity,
      attributes: attributes(v.attributes),
      ...variantExtras(v),
    };
  }
}
