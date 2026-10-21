import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppError, conflict, IdentityClient, notFound, OrganizationsClient, type PaginationQueryDto, skipTake, toPage } from '@uboce/common';

import { bootstrapEmails, env } from '../config.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { PlatformRole } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma.service.js';

type Tx = Prisma.TransactionClient;

export interface Reason {
  reasonCode: string;
  reason: string;
}

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly identity: IdentityClient,
    private readonly organizations: OrganizationsClient,
  ) {}

  /**
   * Effective platform roles. Empty unless the account is active and — by
   * default — has two-factor sign-in, so a stolen password alone never grants
   * staff powers. The first administrator comes from ADMIN_BOOTSTRAP_EMAILS.
   */
  async effectiveRoles(userId: string): Promise<{ roles: PlatformRole[]; blockedReason?: string }> {
    let grants = await this.prisma.platformRoleGrant.findMany({ where: { userId, revokedAt: null } });
    if (grants.length === 0 && bootstrapEmails.size === 0) return { roles: [] };

    const user = await this.identity.getUser(userId);
    if (!user || user.status !== 'active') return { roles: [] };

    if (grants.length === 0 && bootstrapEmails.has(user.email) && user.emailVerified) {
      await this.prisma.$transaction(async (tx) => {
        const already = await tx.platformRoleGrant.count({ where: { userId, role: 'platform_admin' } });
        if (already > 0) return;
        await tx.platformRoleGrant.create({ data: { userId, role: 'platform_admin', reason: 'Bootstrap administrator' } });
        await this.audit(tx, null, 'staff.bootstrap', 'user', userId, { reasonCode: 'bootstrap', reason: 'ADMIN_BOOTSTRAP_EMAILS' });
      });
      this.logger.warn(`Bootstrapped platform_admin for ${userId}`);
      grants = await this.prisma.platformRoleGrant.findMany({ where: { userId, revokedAt: null } });
    }
    if (grants.length === 0) return { roles: [] };
    if (env.REQUIRE_STAFF_MFA && !user.mfaEnabled) return { roles: [], blockedReason: 'mfa_required' };
    return { roles: [...new Set(grants.map((g) => g.role))] };
  }

  // ---- Staff -----------------------------------------------------------------

  async listStaff(query: PaginationQueryDto) {
    const where = { revokedAt: null };
    const [items, total] = await Promise.all([
      this.prisma.platformRoleGrant.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(query) }),
      this.prisma.platformRoleGrant.count({ where }),
    ]);
    return toPage(items, total, query);
  }

  async grant(actorId: string, userId: string, role: PlatformRole, why: Reason) {
    const user = await this.identity.getUser(userId);
    if (!user) throw notFound('User');
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.platformRoleGrant.findFirst({ where: { userId, role, revokedAt: null } });
      if (existing) throw conflict('already_granted', 'This user already has that role');
      const grant = await tx.platformRoleGrant.create({ data: { userId, role, reason: why.reason, grantedByUserId: actorId } });
      await this.audit(tx, actorId, 'staff.grant', 'user', userId, why, { role });
      return grant;
    });
  }

  async revoke(actorId: string, grantId: string, why: Reason) {
    return this.prisma.$transaction(async (tx) => {
      const grant = await tx.platformRoleGrant.findUnique({ where: { id: grantId } });
      if (!grant || grant.revokedAt) throw notFound('Role grant');
      if (grant.role === 'platform_admin') {
        const others = await tx.platformRoleGrant.count({ where: { role: 'platform_admin', revokedAt: null, id: { not: grantId } } });
        if (others === 0) throw new AppError(HttpStatus.CONFLICT, 'last_admin', 'The platform needs at least one administrator');
      }
      const revoked = await tx.platformRoleGrant.update({
        where: { id: grantId },
        data: { revokedAt: new Date(), revokedByUserId: actorId, revokeReason: why.reason },
      });
      await this.audit(tx, actorId, 'staff.revoke', 'user', grant.userId, why, { role: grant.role });
      return revoked;
    });
  }

  // ---- Settings & feature flags --------------------------------------------------

  listSettings() {
    return this.prisma.setting.findMany({ orderBy: { key: 'asc' } });
  }

  async putSetting(actorId: string, key: string, value: Prisma.InputJsonValue, description: string | undefined, why: Reason) {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.setting.findUnique({ where: { key } });
      const setting = await tx.setting.upsert({
        where: { key },
        update: { value, description, updatedByUserId: actorId },
        create: { key, value, description, updatedByUserId: actorId },
      });
      await this.audit(tx, actorId, 'setting.put', 'setting', key, why, { before: before?.value ?? null, after: value });
      return setting;
    });
  }

  listFlags() {
    return this.prisma.featureFlag.findMany({ orderBy: { key: 'asc' } });
  }

  async putFlag(actorId: string, key: string, enabled: boolean, organizationIds: string[], description: string | undefined, why: Reason) {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.featureFlag.findUnique({ where: { key } });
      const flag = await tx.featureFlag.upsert({
        where: { key },
        update: { enabled, organizationIds, description, updatedByUserId: actorId },
        create: { key, enabled, organizationIds, description, updatedByUserId: actorId },
      });
      await this.audit(tx, actorId, 'flag.put', 'feature_flag', key, why, {
        before: before ? { enabled: before.enabled, organizationIds: before.organizationIds } : null,
        after: { enabled, organizationIds },
      });
      return flag;
    });
  }

  /** Flags as one organization sees them; unknown flags are off. */
  async evaluateFlags(organizationId: string | null) {
    const flags = await this.prisma.featureFlag.findMany();
    return Object.fromEntries(flags.map((f) => [f.key, f.enabled || (!!organizationId && f.organizationIds.includes(organizationId))]));
  }

  // ---- Controlled workflows -----------------------------------------------------

  /** Suspension goes through Organization's own API, so its data and events stay its own (PRD 4.2). */
  async setOrganizationStatus(actorId: string, organizationId: string, status: 'active' | 'suspended', why: Reason) {
    const before = await this.organizations.getOrganization(organizationId);
    if (!before) throw notFound('Organization');
    if (before.status === status) throw conflict('no_change', `The organization is already ${status}`);
    const after = await this.organizations.setStatus(organizationId, status);
    await this.audit(this.prisma, actorId, status === 'suspended' ? 'organization.suspend' : 'organization.reinstate', 'organization', organizationId, why, {
      before: before.status,
      after: after.status,
    });
    return after;
  }

  async listAudit(query: PaginationQueryDto & { targetType?: string; targetId?: string }) {
    const where: Prisma.AuditEntryWhereInput = {
      ...(query.targetType ? { targetType: query.targetType } : {}),
      ...(query.targetId ? { targetId: query.targetId } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.auditEntry.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(query) }),
      this.prisma.auditEntry.count({ where }),
    ]);
    return toPage(items, total, query);
  }

  private audit(
    db: Tx | PrismaService,
    actorUserId: string | null,
    action: string,
    targetType: string,
    targetId: string,
    why: Reason,
    details?: Prisma.InputJsonValue,
  ) {
    return db.auditEntry.create({ data: { actorUserId, action, targetType, targetId, reasonCode: why.reasonCode, reason: why.reason, details } });
  }
}
