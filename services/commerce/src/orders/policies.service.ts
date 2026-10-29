import { Injectable } from '@nestjs/common';
import { type ActingOrganization, requireRole } from '@uboce/common';

import type { CancellationPolicy } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma.service.js';
import type { CancellationPolicyDto } from './orders.dto.js';
import type { PolicySnapshot } from './state-machine.js';

const MANAGE_ROLES = ['owner', 'admin'];

export const snapshotOf = (p: CancellationPolicy): PolicySnapshot => ({
  id: p.id,
  version: p.version,
  name: p.name,
  freeCancellationHours: p.freeCancellationHours,
  cancellationFeePct: p.cancellationFeePct.toString(),
  noShowFeePct: p.noShowFeePct.toString(),
  returnWindowDays: p.returnWindowDays,
  restockingFeePct: p.restockingFeePct.toString(),
  pickupHoldHours: p.pickupHoldHours,
  terms: p.terms,
});

/**
 * Cancellation and return terms (PRD addendum 2.6). Publishing a change creates a new
 * version; orders keep the version that applied when they were placed.
 */
@Injectable()
export class PoliciesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Every version, newest first. The first active one is current. */
  history(org: ActingOrganization) {
    return this.prisma.cancellationPolicy.findMany({ where: { organizationId: org.organization.id }, orderBy: { version: 'desc' } });
  }

  /** Any signed-in buyer can read a supplier's current terms before ordering. */
  current(organizationId: string) {
    return this.prisma.cancellationPolicy.findFirst({ where: { organizationId, active: true }, orderBy: { version: 'desc' } });
  }

  async publish(org: ActingOrganization, userId: string, dto: CancellationPolicyDto) {
    requireRole(org, MANAGE_ROLES, 'change cancellation policies');
    const organizationId = org.organization.id;
    return this.prisma.$transaction(async (tx) => {
      const last = await tx.cancellationPolicy.findFirst({ where: { organizationId }, orderBy: { version: 'desc' } });
      await tx.cancellationPolicy.updateMany({ where: { organizationId, active: true }, data: { active: false } });
      return tx.cancellationPolicy.create({
        data: {
          organizationId,
          version: (last?.version ?? 0) + 1,
          name: dto.name.trim(),
          freeCancellationHours: dto.freeCancellationHours,
          cancellationFeePct: dto.cancellationFeePct,
          noShowFeePct: dto.noShowFeePct,
          returnWindowDays: dto.returnWindowDays,
          restockingFeePct: dto.restockingFeePct,
          pickupHoldHours: dto.pickupHoldHours ?? 72,
          terms: dto.terms?.trim() || null,
          createdByUserId: userId,
        },
      });
    });
  }
}
