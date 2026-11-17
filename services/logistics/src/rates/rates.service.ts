import { HttpStatus, Injectable } from '@nestjs/common';
import { type ActingOrganization, AppError, badRequest, requireBusinessAccount, requireRole } from '@uboce/common';
import type { DeliveryQuote, DeliveryQuoteRequest } from '@uboce/contracts';

import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma.service.js';
import { deliveryFee, type RateZone } from './rates.js';

const RATE_ROLES = ['owner', 'admin', 'logistics_operator', 'sales_representative'];

/**
 * Seller delivery rate cards (PRD v2 LOG-06). Every change is a new version;
 * orders keep the version they were priced with, so old orders never change.
 */
@Injectable()
export class RatesService {
  constructor(private readonly prisma: PrismaService) {}

  async current(org: ActingOrganization, currency = 'ETB') {
    return this.prisma.rateCard.findFirst({ where: { organizationId: org.organization.id, currency, active: true } });
  }

  history(org: ActingOrganization) {
    return this.prisma.rateCard.findMany({ where: { organizationId: org.organization.id }, orderBy: [{ currency: 'asc' }, { version: 'desc' }], take: 50 });
  }

  async publish(org: ActingOrganization, userId: string, dto: { currency: string; freeOverAmount?: string | null; zones: RateZone[] }) {
    requireBusinessAccount(org, 'set delivery rates');
    requireRole(org, RATE_ROLES, 'set delivery rates');
    const names = new Set(dto.zones.map((z) => z.name.trim().toLowerCase()));
    if (names.size !== dto.zones.length) throw badRequest('duplicate_zone', 'Zone names must be different');
    const areas = dto.zones.flatMap((z) => z.areas.map((a) => a.trim().toLowerCase()).filter((a) => a !== '*'));
    if (new Set(areas).size !== areas.length) throw badRequest('duplicate_area', 'Each city or region can be in one zone only');
    if (dto.zones.filter((z) => z.areas.some((a) => a.trim() === '*')).length > 1) throw badRequest('duplicate_fallback', 'Only one zone can cover "everywhere else" (*)');

    return this.prisma.$transaction(async (tx) => {
      const last = await tx.rateCard.findFirst({ where: { organizationId: org.organization.id, currency: dto.currency }, orderBy: { version: 'desc' } });
      await tx.rateCard.updateMany({ where: { organizationId: org.organization.id, currency: dto.currency, active: true }, data: { active: false } });
      return tx.rateCard.create({
        data: {
          organizationId: org.organization.id,
          currency: dto.currency,
          version: (last?.version ?? 0) + 1,
          freeOverAmount: dto.freeOverAmount ?? null,
          zones: dto.zones.map((z) => ({ ...z, name: z.name.trim(), areas: z.areas.map((a) => a.trim()) })) as unknown as Prisma.InputJsonValue,
          createdByUserId: userId,
        },
      });
    });
  }

  /** Stops charging delivery through the platform; orders then carry no delivery fee. */
  async withdraw(org: ActingOrganization, currency: string) {
    requireRole(org, RATE_ROLES, 'set delivery rates');
    const { count } = await this.prisma.rateCard.updateMany({ where: { organizationId: org.organization.id, currency, active: true }, data: { active: false } });
    return { withdrawn: count > 0 };
  }

  /** Internal: what a delivery order would cost. No card: no platform fee (arranged outside the order). */
  async quote(request: DeliveryQuoteRequest): Promise<DeliveryQuote> {
    const card = await this.prisma.rateCard.findFirst({ where: { organizationId: request.sellerOrganizationId, currency: request.currency, active: true } });
    if (!card) return { fee: '0.00', currency: request.currency, rateCardId: null, rateCardVersion: null, zone: null, freeDelivery: false };
    const result = deliveryFee({ zones: card.zones as unknown as RateZone[], freeOverAmount: card.freeOverAmount?.toString() ?? null }, request);
    if (!result.ok) throw new AppError(HttpStatus.UNPROCESSABLE_ENTITY, `delivery_${result.reason}`, result.message);
    return { fee: result.fee, currency: request.currency, rateCardId: card.id, rateCardVersion: card.version, zone: result.zone, freeDelivery: result.freeDelivery };
  }
}
