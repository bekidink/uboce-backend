import { Controller, Get, Inject, Injectable, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  type ActingOrganization,
  ActingOrg,
  ActsForOrganization,
  badRequest,
  type EventHandler,
  EventConsumer,
  REDIS,
  RequiresModule,
  requireRole,
} from '@uboce/common';
import type { DomainEvent, EventEnvelope, EventType } from '@uboce/contracts';
import { IsOptional, Matches } from 'class-validator';
import type { Redis } from 'ioredis';

import { SERVICE_NAME } from '../config.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma.service.js';
import { ACTIVITY_TYPES, activityRows } from './activity.js';
import { derivedRates, PROJECTIONS } from './projections.js';

type Tx = Prisma.TransactionClient;
const READ_ROLES = ['owner', 'admin', 'finance_officer', 'auditor', 'procurement_officer', 'sales_representative'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Applies each event's increments exactly once (inbox), with the freshness marker. */
@Injectable()
export class AnalyticsProjector extends EventConsumer<Tx> {
  constructor(@Inject(REDIS) redis: Redis, prisma: PrismaService) {
    super(redis, prisma, SERVICE_NAME);
  }

  protected subscriptions() {
    const handlers: Record<string, EventHandler> = {};
    const types = new Set<EventType>([...(Object.keys(PROJECTIONS) as EventType[]), ...ACTIVITY_TYPES]);
    for (const type of types) {
      const project = PROJECTIONS[type as keyof typeof PROJECTIONS] as ((e: DomainEvent) => ReturnType<NonNullable<(typeof PROJECTIONS)['RFQPublished']>>) | undefined;
      handlers[type] = this.once(type, async (e, tx) => {
        const day = new Date(e.occurredAt.slice(0, 10));
        for (const inc of project?.(e as unknown as DomainEvent) ?? []) {
          await tx.dailyMetric.upsert({
            where: { organizationId_day_metric_currency: { organizationId: inc.organizationId, day, metric: inc.metric, currency: inc.currency ?? '' } },
            update: { value: { increment: inc.amount } },
            create: { organizationId: inc.organizationId, day, metric: inc.metric, currency: inc.currency ?? '', value: inc.amount },
          });
        }
        const activity = activityRows(e as EventEnvelope);
        if (activity.length) await tx.activityEvent.createMany({ data: activity, skipDuplicates: true });
        const state = { lastEventOccurredAt: new Date((e as EventEnvelope).occurredAt), lastIndexedAt: new Date() };
        await tx.indexState.upsert({ where: { id: 'metrics' }, update: state, create: { id: 'metrics', ...state } });
      });
    }
    return handlers;
  }
}

class RangeDto {
  @IsOptional()
  @Matches(DAY)
  from?: string;

  @IsOptional()
  @Matches(DAY)
  to?: string;
}

class SeriesDto extends RangeDto {
  @Matches(/^[a-z_]{2,40}$/)
  metric: string;
}

const range = (q: RangeDto) => {
  const to = q.to ? new Date(q.to) : new Date(new Date().toISOString().slice(0, 10));
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 29 * 86_400_000);
  if (from > to) throw badRequest('invalid_range', '`from` must not be after `to`');
  if (to.getTime() - from.getTime() > 366 * 86_400_000) throw badRequest('range_too_long', 'At most one year at a time');
  return { from, to };
};

/** Every query is scoped to the acting organization (PRD 5.20: tenant isolation). */
@ApiTags('analytics')
@ApiBearerAuth()
@ActsForOrganization()
@RequiresModule('analytics')
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('summary')
  async summary(@ActingOrg() org: ActingOrganization, @Query() q: RangeDto) {
    requireRole(org, READ_ROLES, 'view analytics');
    const { from, to } = range(q);
    const rows = await this.prisma.dailyMetric.groupBy({
      by: ['metric', 'currency'],
      where: { organizationId: org.organization.id, day: { gte: from, lte: to } },
      _sum: { value: true },
    });
    const counts: Record<string, number> = {};
    const amounts: Record<string, Record<string, string>> = {};
    for (const r of rows) {
      const value = r._sum.value ?? new Prisma.Decimal(0);
      if (r.currency) (amounts[r.metric] ??= {})[r.currency] = value.toFixed(2);
      else counts[r.metric] = value.toNumber();
    }
    return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10), counts, amounts, rates: derivedRates(counts) };
  }

  @Get('timeseries')
  async timeseries(@ActingOrg() org: ActingOrganization, @Query() q: SeriesDto) {
    requireRole(org, READ_ROLES, 'view analytics');
    const { from, to } = range(q);
    const rows = await this.prisma.dailyMetric.findMany({
      where: { organizationId: org.organization.id, metric: q.metric, day: { gte: from, lte: to } },
      orderBy: { day: 'asc' },
    });
    return { metric: q.metric, points: rows.map((r) => ({ day: r.day.toISOString().slice(0, 10), currency: r.currency || null, value: r.value.toString() })) };
  }

  /** How current the numbers are. */
  @Get('freshness')
  async freshness() {
    const state = await this.prisma.indexState.findUnique({ where: { id: 'metrics' } });
    return { lastIndexedAt: state?.lastIndexedAt ?? null, lastEventOccurredAt: state?.lastEventOccurredAt ?? null };
  }
}
