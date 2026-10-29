import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  type ActingOrganization,
  ActingOrg,
  ActsForOrganization,
  type AuthUser,
  badRequest,
  CurrentUser,
  notFound,
  requireRole,
} from '@uboce/common';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';

import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma.service.js';

/** Datasets a template can draw from; the web app knows how to fetch and lay out each one. */
export const DATASETS = [
  'sales_orders',
  'purchase_orders',
  'invoices',
  'inventory_balances',
  'stock_movements',
  'shipments',
  'location_sales',
  'activity',
  'transfer_requests',
  'products',
] as const;
export const FORMATS = ['csv', 'xlsx', 'pdf', 'json'] as const;

const MANAGE_ROLES = [
  'owner',
  'admin',
  'finance_officer',
  'auditor',
  'sales_representative',
  'procurement_officer',
  'warehouse_operator',
];

class TemplateDto {
  @IsString()
  @Length(2, 80)
  name: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  description?: string;

  @IsIn(DATASETS)
  dataset: (typeof DATASETS)[number];

  @Matches(/^[A-Za-z][A-Za-z0-9_.]{0,60}$/, { each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(40)
  columns: string[];

  /** Dataset filters, e.g. { "status": "confirmed", "period": "last_30_days", "branchId": "…" }. */
  @IsOptional()
  @IsObject()
  filters?: Record<string, string>;

  @IsIn(FORMATS)
  format: (typeof FORMATS)[number];
}

class UpdateTemplateDto {
  @IsOptional()
  @IsString()
  @Length(2, 80)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  description?: string;

  @IsOptional()
  @Matches(/^[A-Za-z][A-Za-z0-9_.]{0,60}$/, { each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(40)
  columns?: string[];

  @IsOptional()
  @IsObject()
  filters?: Record<string, string>;

  @IsOptional()
  @IsIn(FORMATS)
  format?: (typeof FORMATS)[number];
}

const cleanFilters = (filters: Record<string, unknown> | undefined) => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(filters ?? {})) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(k)) throw badRequest('invalid_filter', `Unknown filter "${k}"`);
    if (v === null || v === undefined || v === '') continue;
    if (typeof v !== 'string' || v.length > 200)
      throw badRequest('invalid_filter', `Filter "${k}" must be text`);
    out[k] = v;
  }
  if (Object.keys(out).length > 20) throw badRequest('invalid_filter', 'Too many filters');
  return out;
};

/** Saved report layouts, shared by everyone in the organization. */
@ApiTags('analytics')
@ApiBearerAuth()
@ActsForOrganization()
@Controller('analytics/report-templates')
export class ReportTemplatesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list(@ActingOrg() org: ActingOrganization) {
    return this.prisma.reportTemplate.findMany({
      where: { organizationId: org.organization.id },
      orderBy: { name: 'asc' },
    });
  }

  @Post()
  async create(
    @ActingOrg() org: ActingOrganization,
    @CurrentUser() user: AuthUser,
    @Body() dto: TemplateDto,
  ) {
    requireRole(org, MANAGE_ROLES, 'save report templates');
    if ((await this.prisma.reportTemplate.count({ where: { organizationId: org.organization.id } })) >= 100) {
      throw badRequest('too_many_templates', 'An organization can keep up to 100 report templates');
    }
    return this.prisma.reportTemplate.create({
      data: {
        organizationId: org.organization.id,
        name: dto.name.trim(),
        description: dto.description?.trim() || null,
        dataset: dto.dataset,
        columns: dto.columns,
        filters: cleanFilters(dto.filters) as Prisma.InputJsonValue,
        format: dto.format,
        createdByUserId: user.userId,
      },
    });
  }

  @Patch(':templateId')
  async update(
    @ActingOrg() org: ActingOrganization,
    @Param('templateId', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateTemplateDto,
  ) {
    requireRole(org, MANAGE_ROLES, 'edit report templates');
    await this.owned(org, id);
    return this.prisma.reportTemplate.update({
      where: { id },
      data: {
        name: dto.name?.trim(),
        description: dto.description === undefined ? undefined : dto.description.trim() || null,
        columns: dto.columns,
        filters: dto.filters ? (cleanFilters(dto.filters) as Prisma.InputJsonValue) : undefined,
        format: dto.format,
      },
    });
  }

  @Delete(':templateId')
  @HttpCode(204)
  async remove(@ActingOrg() org: ActingOrganization, @Param('templateId', new ParseUUIDPipe()) id: string) {
    requireRole(org, MANAGE_ROLES, 'delete report templates');
    await this.owned(org, id);
    await this.prisma.reportTemplate.delete({ where: { id } });
  }

  private async owned(org: ActingOrganization, id: string) {
    const t = await this.prisma.reportTemplate.findFirst({
      where: { id, organizationId: org.organization.id },
    });
    if (!t) throw notFound('Report template');
    return t;
  }
}
