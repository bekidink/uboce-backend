import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type ActingOrganization,
  AppError,
  badRequest,
  buildEvent,
  conflict,
  notFound,
  requireRole,
  skipTake,
  toOutboxRow,
  toPage,
} from '@uboce/common';

import { SERVICE_NAME } from '../config.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma.service.js';
import type { CreateProductDto, ListProductsQueryDto, UpdateProductDto, UpdateVariantDto, VariantDto } from './catalog.dto.js';
import { normalizeAttributes, publicationProblems } from './publishing.js';

type Tx = Prisma.TransactionClient;

/** Roles that may manage their organization's catalog (PRD 3.1: sales reps, producers). */
const CATALOG_ROLES = ['owner', 'admin', 'sales_representative', 'manufacturer', 'farmer'];

const productInclude = { variants: { orderBy: { createdAt: 'asc' } }, category: true } as const;
type ProductWithVariants = Prisma.ProductGetPayload<{ include: typeof productInclude }>;

const attributes = (input: Record<string, unknown> | undefined) => {
  try {
    return normalizeAttributes(input);
  } catch (error) {
    throw badRequest('invalid_attributes', (error as Error).message);
  }
};

const skuTaken = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
    ? conflict('sku_taken', 'Another product in your organization already uses this SKU')
    : error;

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  listCategories() {
    return this.prisma.category.findMany({ orderBy: [{ parentId: 'asc' }, { name: 'asc' }] });
  }

  async create(org: ActingOrganization, userId: string, dto: CreateProductDto) {
    requireRole(org, CATALOG_ROLES, 'manage the catalog');
    await this.category(dto.categoryId);
    const organizationId = org.organization.id;
    try {
      return await this.prisma.product.create({
        data: {
          organizationId,
          name: dto.name.trim(),
          description: dto.description?.trim() || null,
          categoryId: dto.categoryId,
          unitOfMeasure: dto.unitOfMeasure,
          attributes: attributes(dto.attributes),
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
      include: { ...productInclude, variants: { where: { isActive: true }, orderBy: { createdAt: 'asc' } } },
    });
    if (!product) throw notFound('Product');
    return product;
  }

  async update(org: ActingOrganization, productId: string, dto: UpdateProductDto) {
    requireRole(org, CATALOG_ROLES, 'manage the catalog');
    const product = await this.owned(org, productId);
    if (product.status === 'archived') throw conflict('product_archived', 'Archived products cannot be changed');
    if (dto.categoryId) await this.category(dto.categoryId);

    return this.prisma.$transaction(async (tx) => {
      await tx.product.update({
        where: { id: productId },
        data: {
          name: dto.name?.trim(),
          description: dto.description === undefined ? undefined : dto.description.trim() || null,
          categoryId: dto.categoryId,
          unitOfMeasure: dto.unitOfMeasure,
          attributes: dto.attributes ? attributes(dto.attributes) : undefined,
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
        data: { name: dto.name?.trim(), price: dto.price, minOrderQuantity: dto.minOrderQuantity, isActive: dto.isActive },
      });
      const updated = await this.afterChange(tx, productId);
      if (updated.status === 'published' && !updated.variants.some((v) => v.isActive)) {
        throw conflict('last_active_variant', 'A published product needs at least one active variant; archive it instead');
      }
      return updated;
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
  private async afterChange(tx: Tx, productId: string): Promise<ProductWithVariants> {
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
              })),
            publishedAt: (product.publishedAt ?? new Date()).toISOString(),
          }),
        ),
      });
    }
    return product;
  }

  /** Other organizations' products look like they don't exist. */
  private async owned(org: ActingOrganization, productId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, organizationId: org.organization.id },
      include: productInclude,
    });
    if (!product) throw notFound('Product');
    return product;
  }

  private async category(categoryId: string) {
    const category = await this.prisma.category.findUnique({ where: { id: categoryId } });
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
    };
  }
}
