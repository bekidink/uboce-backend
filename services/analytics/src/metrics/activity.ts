import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  type ActingOrganization,
  ActingOrg,
  ActsForOrganization,
  badRequest,
  PaginationQueryDto,
  requireRole,
  skipTake,
  toPage,
} from '@uboce/common';
import type { EventEnvelope, EventType } from '@uboce/contracts';
import { IsIn, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';

import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma.service.js';

export const AREAS = [
  'sales',
  'procurement',
  'inventory',
  'warehouse',
  'logistics',
  'finance',
  'quality',
  'catalog',
  'organization',
  'disputes',
  'returns',
  'other',
] as const;
export type Area = (typeof AREAS)[number];

/** Area and plain-language wording for each event the activity log records. */
const ACTIVITY: Partial<Record<EventType, { area: Area; text: string }>> = {
  OrganizationCreated: { area: 'organization', text: 'Organization created' },
  OrganizationUpdated: { area: 'organization', text: 'Organization details updated' },
  MembershipAdded: { area: 'organization', text: 'Member added' },
  MembershipRevoked: { area: 'organization', text: 'Member removed' },
  MembershipUpdated: { area: 'organization', text: 'Member role or locations changed' },
  OrganizationLocationsChanged: { area: 'organization', text: 'Locations changed' },
  EntitlementChanged: { area: 'organization', text: 'Module access changed' },
  KycVerificationDecided: { area: 'organization', text: 'Identity verification decided' },
  KybVerificationDecided: { area: 'organization', text: 'Business verification decided' },
  ProductPublished: { area: 'catalog', text: 'Product published' },
  ProductArchived: { area: 'catalog', text: 'Product archived' },
  RFQPublished: { area: 'procurement', text: 'RFQ published' },
  QuotationSubmitted: { area: 'procurement', text: 'Quotation submitted' },
  QuotationAccepted: { area: 'procurement', text: 'Quotation accepted' },
  PurchaseOrderCreated: { area: 'sales', text: 'Order placed' },
  PurchaseOrderConfirmed: { area: 'sales', text: 'Order confirmed' },
  PurchaseOrderCancelled: { area: 'sales', text: 'Order cancelled' },
  PurchaseOrderFulfillmentUpdated: { area: 'sales', text: 'Order fulfilment updated' },
  OrderChargeAssessed: { area: 'finance', text: 'Order fee charged' },
  StockReserved: { area: 'inventory', text: 'Stock reserved' },
  StockReservationFailed: { area: 'inventory', text: 'Stock reservation failed' },
  StockMovementPosted: { area: 'inventory', text: 'Stock movement posted' },
  GoodsReceived: { area: 'warehouse', text: 'Goods received' },
  InspectionCompleted: { area: 'quality', text: 'Inspection completed' },
  QualityClaimOpened: { area: 'quality', text: 'Quality claim opened' },
  ReviewPublished: { area: 'quality', text: 'Review published' },
  ShipmentDispatched: { area: 'logistics', text: 'Shipment dispatched' },
  ShipmentStatusChanged: { area: 'logistics', text: 'Shipment status changed' },
  ShipmentCarrierChanged: { area: 'logistics', text: 'Shipment carrier changed' },
  DeliveryConfirmed: { area: 'logistics', text: 'Delivery confirmed' },
  ProduceLotCreated: { area: 'inventory', text: 'Produce lot recorded' },
  ProductionCompleted: { area: 'inventory', text: 'Production completed' },
  InvoiceIssued: { area: 'finance', text: 'Invoice issued' },
  ReconciliationUpdated: { area: 'finance', text: 'Payment reconciled' },
  RefundStatusChanged: { area: 'finance', text: 'Refund status changed' },
  DisputeOpened: { area: 'disputes', text: 'Dispute opened' },
  DisputeResolved: { area: 'disputes', text: 'Dispute resolved' },
  ReturnRequested: { area: 'returns', text: 'Return requested' },
  ReturnStatusChanged: { area: 'returns', text: 'Return status changed' },
};

export const ACTIVITY_TYPES = Object.keys(ACTIVITY) as EventType[];
export const activityLabel = (type: string) => ACTIVITY[type as EventType]?.text ?? type;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTOR_KEYS = [
  'actorUserId',
  'userId',
  'createdByUserId',
  'decidedByUserId',
  'changedByUserId',
  'requestedByUserId',
];
const REF_KEYS = [
  'orderNumber',
  'number',
  'invoiceNumber',
  'rfqNumber',
  'shipmentNumber',
  'returnNumber',
  'lotCode',
  'name',
  'sku',
];
const STATUS_KEYS = ['status', 'decision', 'to', 'outcome', 'type'];

/** Organizations an event concerns: every `…organizationId` / `…OrganizationId` value, plus `organizationIds`. */
export function organizationsIn(data: Record<string, unknown>) {
  const own = new Set<string>();
  const others = new Set<string>();
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string' && UUID.test(value)) {
      if (key === 'organizationId') own.add(value);
      else if (/OrganizationId$/.test(key)) others.add(value);
    } else if (key === 'organizationIds' && Array.isArray(value)) {
      for (const v of value) if (typeof v === 'string' && UUID.test(v)) others.add(v);
    }
  }
  return { own, others };
}

/** Activity rows for one event (none for event types the log doesn't record). */
export function activityRows(e: EventEnvelope) {
  const meta = ACTIVITY[e.eventType as EventType];
  if (!meta) return [];
  const data = (e.data ?? {}) as Record<string, unknown>;
  const { own, others } = organizationsIn(data);
  const str = (keys: string[]) =>
    keys
      .map((k) => data[k])
      .find((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 120);
  const status = str(STATUS_KEYS);
  const reference = str(REF_KEYS) ?? null;
  const actor = str(ACTOR_KEYS);
  const branch = str(['branchId', 'fulfillmentBranchId']);
  const summary = [
    meta.text,
    status && !meta.text.toLowerCase().includes(status.replace(/_/g, ' '))
      ? `(${status.replace(/_/g, ' ')})`
      : null,
  ]
    .filter(Boolean)
    .join(' ');
  // The organization that "owns" the event did it; the others are the counterparties it happened to.
  const actorOrg = own.size ? own : new Set([...others].slice(0, 1));
  const all = new Set([...own, ...others]);
  return [...all].map((organizationId) => ({
    eventId: e.eventId,
    organizationId,
    eventType: e.eventType,
    area: meta.area,
    summary,
    reference,
    aggregateId: e.aggregateId,
    branchId: branch && UUID.test(branch) ? branch : null,
    actorUserId: actor && UUID.test(actor) ? actor : null,
    own: actorOrg.has(organizationId),
    occurredAt: new Date(e.occurredAt),
    data: data as Prisma.InputJsonValue,
  }));
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const READ_ROLES = [
  'owner',
  'admin',
  'finance_officer',
  'auditor',
  'procurement_officer',
  'sales_representative',
  'warehouse_operator',
  'logistics_operator',
];

class ActivityQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(AREAS)
  area?: Area;

  @IsOptional()
  @Matches(/^[A-Za-z]{3,60}$/)
  eventType?: string;

  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @IsUUID()
  actorUserId?: string;

  @IsOptional()
  @Matches(DAY)
  from?: string;

  @IsOptional()
  @Matches(DAY)
  to?: string;

  /** Searches the wording and reference (order number, invoice number…). */
  @IsOptional()
  @IsString()
  @Length(1, 100)
  q?: string;

  /** mine: things your organization did; others: things partners did involving you. */
  @IsOptional()
  @IsIn(['mine', 'others'])
  party?: 'mine' | 'others';
}

export function activityWhere(
  organizationId: string,
  q: Omit<ActivityQueryDto, 'page' | 'limit'>,
): Prisma.ActivityEventWhereInput {
  const from = q.from ? new Date(q.from) : undefined;
  const to = q.to ? new Date(new Date(q.to).getTime() + 86_400_000) : undefined;
  if (from && to && from >= to) throw badRequest('invalid_range', '`from` must not be after `to`');
  return {
    organizationId,
    ...(q.area ? { area: q.area } : {}),
    ...(q.eventType ? { eventType: q.eventType } : {}),
    ...(q.branchId ? { branchId: q.branchId } : {}),
    ...(q.actorUserId ? { actorUserId: q.actorUserId } : {}),
    ...(q.party ? { own: q.party === 'mine' } : {}),
    ...(from || to ? { occurredAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}),
    ...(q.q
      ? {
          OR: [
            { summary: { contains: q.q, mode: 'insensitive' } },
            { reference: { contains: q.q, mode: 'insensitive' } },
            { aggregateId: q.q },
          ],
        }
      : {}),
  };
}

/** The organization's activity log, filterable, newest first. */
@ApiTags('analytics')
@ApiBearerAuth()
@ActsForOrganization()
@Controller('analytics/activity')
export class ActivityController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@ActingOrg() org: ActingOrganization, @Query() q: ActivityQueryDto) {
    requireRole(org, READ_ROLES, 'view the activity log');
    const where = activityWhere(org.organization.id, q);
    const [items, total] = await Promise.all([
      this.prisma.activityEvent.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
        omit: { data: true },
        ...skipTake(q),
      }),
      this.prisma.activityEvent.count({ where }),
    ]);
    return toPage(items, total, q);
  }

  /** Counts per area and event type, for filters and the activity report. */
  @Get('facets')
  async facets(@ActingOrg() org: ActingOrganization, @Query() q: ActivityQueryDto) {
    requireRole(org, READ_ROLES, 'view the activity log');
    const where = activityWhere(org.organization.id, { ...q, area: undefined, eventType: undefined });
    const rows = await this.prisma.activityEvent.groupBy({
      by: ['area', 'eventType'],
      where,
      _count: { _all: true },
    });
    return {
      areas: AREAS.map((a) => ({
        value: a,
        count: rows.filter((r) => r.area === a).reduce((s, r) => s + r._count._all, 0),
      })).filter((a) => a.count > 0),
      eventTypes: rows.map((r) => ({
        value: r.eventType,
        area: r.area,
        label: ACTIVITY[r.eventType as EventType]?.text ?? r.eventType,
        count: r._count._all,
      })),
    };
  }
}
