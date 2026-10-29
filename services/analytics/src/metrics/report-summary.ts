import { Body, Controller, HttpCode, Injectable, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  type ActingOrganization,
  ActingOrg,
  ActsForOrganization,
  badRequest,
  CommerceClient,
  GroqClient,
  OrganizationsClient,
  RequiresModule,
  requireRole,
} from '@uboce/common';
import { IsOptional, IsUUID, Matches } from 'class-validator';
import { z } from 'zod';

import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma.service.js';
import { activityLabel } from './activity.js';
import { derivedRates } from './projections.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const READ_ROLES = [
  'owner',
  'admin',
  'finance_officer',
  'auditor',
  'sales_representative',
  'warehouse_operator',
];

/** One figure the summary is built from; every sentence cites the figures it uses. */
export interface Source {
  id: string;
  label: string;
  value: string;
}

export interface Point {
  text: string;
  sourceIds: string[];
}

export interface Summary {
  headline: string;
  highlights: Point[];
  concerns: Point[];
  suggestions: Point[];
}

class SummaryDto {
  @IsOptional()
  @Matches(DAY)
  from?: string;

  @IsOptional()
  @Matches(DAY)
  to?: string;

  /** One store or location only (store activity report). */
  @IsOptional()
  @IsUUID()
  branchId?: string;
}

/** Keeps only points whose citations all exist, so every sentence is traceable. */
export function keepCited(summary: Summary, sources: Source[]): Summary {
  const ids = new Set(sources.map((s) => s.id));
  const ok = (p: Point) => p.sourceIds.length > 0 && p.sourceIds.every((id) => ids.has(id));
  return {
    headline: summary.headline,
    highlights: summary.highlights.filter(ok),
    concerns: summary.concerns.filter(ok),
    suggestions: summary.suggestions.filter(ok),
  };
}

/**
 * Plain-language summary from fixed rules (PRD addendum 2.11): no external AI service.
 * Each sentence quotes figures exactly as they appear in the sources and cites them.
 */
export function ruleSummary(sources: Source[]): Summary {
  const find = (label: string) => sources.find((s) => s.label === label);
  const num = (s: Source | undefined) => (s ? Number(s.value) : NaN);
  const highlights: Point[] = [];
  const concerns: Point[] = [];
  const suggestions: Point[] = [];

  const orders = find('Orders received');
  if (orders)
    highlights.push({ text: `You received ${orders.value} orders in this period.`, sourceIds: [orders.id] });
  for (const s of sources.filter((x) => x.label.startsWith('Sales value')).slice(0, 2))
    highlights.push({ text: `${s.label}: ${s.value}.`, sourceIds: [s.id] });

  // Best location by orders.
  const locationOrders = sources.filter((s) => s.label.endsWith(': orders')).sort((a, b) => num(b) - num(a));
  if (locationOrders.length > 1) {
    highlights.push({
      text: `${locationOrders[0]!.label.replace(': orders', '')} handled the most orders (${locationOrders[0]!.value}).`,
      sourceIds: [locationOrders[0]!.id],
    });
  }
  for (const s of sources.filter((x) => x.label.endsWith(': best-selling product')).slice(0, 2)) {
    highlights.push({
      text: `${s.label.replace(': best-selling product', '')}: best seller was ${s.value}.`,
      sourceIds: [s.id],
    });
  }

  const confirmation = find('Order confirmation rate (%)');
  if (confirmation && num(confirmation) < 80) {
    concerns.push({
      text: `Only ${confirmation.value}% of orders were confirmed.`,
      sourceIds: [confirmation.id],
    });
    suggestions.push({
      text: 'Confirm or decline new orders promptly so buyers are not left waiting.',
      sourceIds: [confirmation.id],
    });
  }
  const delivery = find('Complete delivery rate (%)');
  if (delivery && num(delivery) < 90) {
    concerns.push({ text: `${delivery.value}% of deliveries arrived complete.`, sourceIds: [delivery.id] });
    suggestions.push({
      text: 'Check packing and quantities before dispatch to reduce partial deliveries.',
      sourceIds: [delivery.id],
    });
  }
  const paidRate = find('Invoices paid rate (%)');
  if (paidRate && num(paidRate) < 70) {
    concerns.push({ text: `${paidRate.value}% of issued invoices are paid.`, sourceIds: [paidRate.id] });
    suggestions.push({
      text: 'Offer online payment on open invoices and follow up on overdue ones.',
      sourceIds: [paidRate.id],
    });
  }
  for (const s of sources
    .filter((x) => /(cancelled|failed deliveries|uncollected|returns)$/.test(x.label) && num(x) > 0)
    .slice(0, 4)) {
    concerns.push({ text: `${s.label}: ${s.value}.`, sourceIds: [s.id] });
  }
  const uncollected = sources.filter((s) => s.label.endsWith(': uncollected') && num(s) > 0);
  if (uncollected.length) {
    suggestions.push({
      text: 'Remind buyers before the pickup hold ends to cut no-shows.',
      sourceIds: uncollected.map((s) => s.id),
    });
  }

  return {
    headline: orders
      ? `${orders.value} orders received this period.`
      : sources.length
        ? 'Little sales activity in this period.'
        : 'No activity in this period.',
    highlights: highlights.slice(0, 4),
    concerns: concerns.slice(0, 4),
    suggestions: suggestions.slice(0, 4),
  };
}

const PointSchema = z.object({ text: z.string().max(400), sourceIds: z.array(z.string()).max(6) });
const SummarySchema = z.object({
  headline: z.string().max(300),
  highlights: z.array(PointSchema).max(5),
  concerns: z.array(PointSchema).max(5),
  suggestions: z.array(PointSchema).max(5),
});

const SYSTEM = `You write short performance summaries for owners and store managers of Ethiopian businesses in any sector (trade, retail, agriculture, manufacturing, logistics and services).
Use only the numbered sources given. Every highlight, concern and suggestion must list the ids of the sources it relies on in "sourceIds".
Quote numbers exactly as written in the sources; do not calculate new figures, forecast, or mention anything the sources don't contain.
If there is little activity, say so plainly. One sentence per point, at most four of each kind.
Return {"headline", "highlights": [{"text","sourceIds"}], "concerns": [...], "suggestions": [...]}.`;

@Injectable()
export class ReportSummaryService {
  private readonly ai = new GroqClient();

  constructor(
    private readonly prisma: PrismaService,
    private readonly commerce: CommerceClient,
    private readonly organizations: OrganizationsClient,
  ) {}

  /** Collects the period's figures as numbered sources. */
  async sources(organizationId: string, from: string, to: string, branchId?: string): Promise<Source[]> {
    const rows = await this.prisma.dailyMetric.groupBy({
      by: ['metric', 'currency'],
      where: { organizationId, day: { gte: new Date(from), lte: new Date(to) } },
      _sum: { value: true },
    });
    const sources: Source[] = [];
    const add = (label: string, value: string | number | null) => {
      if (value === null || value === undefined) return;
      sources.push({ id: `S${sources.length + 1}`, label, value: String(value) });
    };
    const counts: Record<string, number> = {};
    const LABELS: Record<string, string> = {
      orders_received: 'Orders received',
      orders_placed: 'Orders placed',
      orders_confirmed: 'Orders confirmed',
      orders_cancelled: 'Orders cancelled',
      quotations_submitted: 'Quotations submitted',
      quotations_won: 'Quotations won',
      rfqs_published: 'RFQs published',
      deliveries_made: 'Deliveries made',
      deliveries_complete: 'Complete deliveries',
      invoices_issued: 'Invoices issued',
      invoices_paid: 'Invoices paid',
      disputes_received: 'Disputes received',
    };
    // Organization-wide figures (left out of a single store's report, where they would mislead).
    if (!branchId) {
      for (const r of rows.filter((x) => !x.currency))
        counts[r.metric] = (r._sum.value ?? new Prisma.Decimal(0)).toNumber();
      for (const [metric, label] of Object.entries(LABELS)) if (counts[metric]) add(label, counts[metric]);
      for (const r of rows.filter((x) => x.currency)) {
        const label =
          r.metric === 'sales_value'
            ? 'Sales value'
            : r.metric === 'purchase_value'
              ? 'Purchase value'
              : r.metric === 'invoiced_value'
                ? 'Invoiced value'
                : null;
        if (label) add(`${label} (${r.currency})`, (r._sum.value ?? new Prisma.Decimal(0)).toFixed(2));
      }
      const rates = derivedRates(counts);
      add('Order confirmation rate (%)', rates.orderConfirmationRatePct);
      add('Quote win rate (%)', rates.quoteWinRatePct);
      add('Complete delivery rate (%)', rates.completeDeliveryRatePct);
      add('Invoices paid rate (%)', rates.invoicePaidRatePct);
    }

    // Per-location figures from Commerce (store reports).
    const report = (await this.commerce.locationReport(organizationId, from, to).catch(() => null)) as {
      locations: {
        branchId: string | null;
        orders: number;
        cancelled: number;
        uncollected: number;
        deliveryFailed: number;
        returns: number;
        sales: Record<string, string>;
        topProducts: { description: string; value: string; currency: string }[];
      }[];
    } | null;
    for (const l of (report?.locations ?? []).filter((x) => !branchId || x.branchId === branchId)) {
      const name = l.branchId
        ? ((await this.organizations.getBranch(organizationId, l.branchId).catch(() => null))?.name ??
          'Unnamed location')
        : 'Unassigned orders';
      add(`${name}: orders`, l.orders);
      for (const [currency, value] of Object.entries(l.sales))
        add(`${name}: sales value (${currency})`, value);
      if (l.cancelled) add(`${name}: cancelled`, l.cancelled);
      if (l.deliveryFailed) add(`${name}: failed deliveries`, l.deliveryFailed);
      if (l.uncollected) add(`${name}: uncollected`, l.uncollected);
      if (l.returns) add(`${name}: returns`, l.returns);
      const top = l.topProducts[0];
      if (top) add(`${name}: best-selling product`, `${top.description} (${top.value} ${top.currency})`);
    }

    // What the business did in the period (activity log), most frequent first.
    const activity = await this.prisma.activityEvent.groupBy({
      by: ['eventType'],
      where: {
        organizationId,
        own: true,
        occurredAt: { gte: new Date(from), lt: new Date(new Date(to).getTime() + 86_400_000) },
        ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}),
      },
      _count: { _all: true },
      orderBy: { _count: { eventType: 'desc' } },
      take: 10,
    });
    for (const a of activity)
      add(
        `${branchId ? 'Organization-wide activity' : 'Activity'}: ${activityLabel(a.eventType).toLowerCase()}`,
        a._count._all,
      );
    return sources;
  }

  async summarize(org: ActingOrganization, dto: SummaryDto) {
    requireRole(org, READ_ROLES, 'view report summaries');
    const to = dto.to ?? new Date().toISOString().slice(0, 10);
    const from = dto.from ?? new Date(new Date(to).getTime() - 29 * 86_400_000).toISOString().slice(0, 10);
    if (from > to) throw badRequest('invalid_range', '`from` must not be after `to`');
    const sources = await this.sources(org.organization.id, from, to, dto.branchId);
    const rules = () => ({
      from,
      to,
      branchId: dto.branchId ?? null,
      sources,
      generatedBy: 'rules',
      summary: keepCited(ruleSummary(sources), sources),
    });
    if (!this.ai.enabled || !sources.length) return rules();
    try {
      const summary = await this.ai.json({
        system: SYSTEM,
        user: [
          `Business: ${org.organization.name}`,
          ...(dto.branchId
            ? ['Report for a single store/location; organization-wide activity is context only.']
            : []),
          `Period: ${from} to ${to}`,
          '',
          'Sources:',
          ...sources.map((s) => `[${s.id}] ${s.label}: ${s.value}`),
        ].join('\n'),
        schema: SummarySchema,
      });
      const cited = keepCited(summary, sources);
      // A summary that cites nothing is no better than the rules.
      if (![...cited.highlights, ...cited.concerns, ...cited.suggestions].length) return rules();
      return {
        from,
        to,
        branchId: dto.branchId ?? null,
        sources,
        generatedBy: this.ai.modelName,
        summary: cited,
      };
    } catch {
      return rules();
    }
  }
}

/** Plain-language summary of the period, every point citing its figures (PRD addendum 2.11). */
@ApiTags('analytics')
@ApiBearerAuth()
@ActsForOrganization()
@RequiresModule('report_summaries')
@Controller('analytics')
export class ReportSummaryController {
  constructor(private readonly summaries: ReportSummaryService) {}

  @Post('report-summary')
  @HttpCode(200)
  summary(@ActingOrg() org: ActingOrganization, @Body() dto: SummaryDto) {
    return this.summaries.summarize(org, dto);
  }
}
