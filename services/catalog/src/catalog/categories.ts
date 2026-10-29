import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  type ActingOrganization,
  ActingOrg,
  ActsForOrganization,
  badRequest,
  conflict,
  notFound,
  requireRole,
} from '@uboce/common';
import { IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';

import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma.service.js';
import { CATALOG_ROLES } from './catalog.service.js';

class CategoryDto {
  @IsString()
  @Length(2, 80)
  name: string;

  /** The platform category it sits under (sets the sector buyers browse). */
  @IsUUID()
  parentId: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder?: number;
}

class UpdateCategoryDto {
  @IsOptional()
  @IsString()
  @Length(2, 80)
  name?: string;

  @IsOptional()
  @IsUUID()
  parentId?: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder?: number;
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'category';

/**
 * A business's own categories ("Our coffees", "Spare parts"), always under a platform category so
 * products stay findable by sector in the marketplace. Platform categories are seeded in code.
 */
@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Platform categories, plus the acting organization's own when given. */
  list(organizationId?: string) {
    return this.prisma.category.findMany({
      where: { OR: [{ organizationId: null }, ...(organizationId ? [{ organizationId }] : [])] },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async mine(org: ActingOrganization) {
    const rows = await this.prisma.category.findMany({
      where: { organizationId: org.organization.id },
      include: { parent: true, _count: { select: { products: true } } },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return rows.map(({ _count, ...c }) => ({ ...c, productCount: _count.products }));
  }

  async create(org: ActingOrganization, dto: CategoryDto) {
    requireRole(org, CATALOG_ROLES, 'manage categories');
    const parent = await this.platformParent(dto.parentId);
    const count = await this.prisma.category.count({ where: { organizationId: org.organization.id } });
    if (count >= 200)
      throw badRequest('too_many_categories', 'An organization can have up to 200 categories');
    const name = dto.name.trim();
    if (
      await this.prisma.category.findFirst({
        where: { organizationId: org.organization.id, name: { equals: name, mode: 'insensitive' } },
      })
    ) {
      throw conflict('category_exists', 'You already have a category with this name');
    }
    return this.prisma.category.create({
      data: {
        slug: `${slugify(name)}-${org.organization.id.slice(0, 8)}`,
        name,
        parentId: parent.id,
        organizationId: org.organization.id,
        description: dto.description?.trim() || null,
        sortOrder: dto.sortOrder ?? 0,
        // Products in it follow the sector's attributes (grade, moisture…).
        requiredAttributes: parent.requiredAttributes,
        attributeDefinitions: parent.attributeDefinitions as Prisma.InputJsonValue,
      },
    });
  }

  async update(org: ActingOrganization, id: string, dto: UpdateCategoryDto) {
    requireRole(org, CATALOG_ROLES, 'manage categories');
    await this.owned(org, id);
    const parent = dto.parentId ? await this.platformParent(dto.parentId) : null;
    return this.prisma.category.update({
      where: { id },
      data: {
        name: dto.name?.trim(),
        description: dto.description === undefined ? undefined : dto.description.trim() || null,
        sortOrder: dto.sortOrder,
        ...(parent
          ? {
              parentId: parent.id,
              requiredAttributes: parent.requiredAttributes,
              attributeDefinitions: parent.attributeDefinitions as Prisma.InputJsonValue,
            }
          : {}),
      },
    });
  }

  async remove(org: ActingOrganization, id: string) {
    requireRole(org, CATALOG_ROLES, 'manage categories');
    await this.owned(org, id);
    const used = await this.prisma.product.count({ where: { categoryId: id } });
    if (used) throw conflict('category_in_use', `${used} product(s) use this category; move them first`);
    await this.prisma.category.delete({ where: { id } });
  }

  private async owned(org: ActingOrganization, id: string) {
    const category = await this.prisma.category.findFirst({
      where: { id, organizationId: org.organization.id },
    });
    if (!category) throw notFound('Category');
    return category;
  }

  private async platformParent(id: string) {
    const parent = await this.prisma.category.findFirst({ where: { id, organizationId: null } });
    if (!parent) throw badRequest('unknown_category', 'Choose one of the platform categories as the parent');
    return parent;
  }
}

/** Slugs from the sector down to the category, e.g. ["agriculture", "coffee", "our-coffees-1a2b3c4d"]. */
export async function categoryPath(
  db: {
    category: {
      findUnique: (a: { where: { id: string } }) => Promise<{ slug: string; parentId: string | null } | null>;
    };
  },
  id: string,
) {
  const path: string[] = [];
  let next: string | null = id;
  for (let depth = 0; next && depth < 6; depth++) {
    const c: { slug: string; parentId: string | null } | null = await db.category.findUnique({
      where: { id: next },
    });
    if (!c) break;
    path.unshift(c.slug);
    next = c.parentId;
  }
  return path;
}

@ApiTags('catalog')
@ApiBearerAuth()
@ActsForOrganization()
@Controller('catalog/categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  /** Platform categories plus your own (for product forms). */
  @Get('available')
  available(@ActingOrg() org: ActingOrganization) {
    return this.categories.list(org.organization.id);
  }

  /** Your organization's own categories, with product counts. */
  @Get('mine')
  mine(@ActingOrg() org: ActingOrganization) {
    return this.categories.mine(org);
  }

  @Post()
  create(@ActingOrg() org: ActingOrganization, @Body() dto: CategoryDto) {
    return this.categories.create(org, dto);
  }

  @Patch(':categoryId')
  update(
    @ActingOrg() org: ActingOrganization,
    @Param('categoryId', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateCategoryDto,
  ) {
    return this.categories.update(org, id, dto);
  }

  @Delete(':categoryId')
  @HttpCode(204)
  remove(@ActingOrg() org: ActingOrganization, @Param('categoryId', new ParseUUIDPipe()) id: string) {
    return this.categories.remove(org, id);
  }
}
