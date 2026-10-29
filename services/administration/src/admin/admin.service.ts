import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  AppError,
  badRequest,
  conflict,
  emitEvent,
  IdentityClient,
  notFound,
  OrganizationsClient,
  type PaginationQueryDto,
  skipTake,
  toPage,
} from '@uboce/common';
import { BUSINESS_TYPES, MODULES, moduleDefault } from '@uboce/contracts';

import { bootstrapEmails, env, SERVICE_NAME } from '../config.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { AuditQueryDto } from './admin.dto.js';
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
        await tx.platformRoleGrant.create({
          data: { userId, role: 'platform_admin', reason: 'Bootstrap administrator' },
        });
        await this.audit(tx, null, 'staff.bootstrap', 'user', userId, {
          reasonCode: 'bootstrap',
          reason: 'ADMIN_BOOTSTRAP_EMAILS',
        });
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
      const grant = await tx.platformRoleGrant.create({
        data: { userId, role, reason: why.reason, grantedByUserId: actorId },
      });
      await this.audit(tx, actorId, 'staff.grant', 'user', userId, why, { role });
      return grant;
    });
  }

  async revoke(actorId: string, grantId: string, why: Reason) {
    return this.prisma.$transaction(async (tx) => {
      const grant = await tx.platformRoleGrant.findUnique({ where: { id: grantId } });
      if (!grant || grant.revokedAt) throw notFound('Role grant');
      if (grant.role === 'platform_admin') {
        const others = await tx.platformRoleGrant.count({
          where: { role: 'platform_admin', revokedAt: null, id: { not: grantId } },
        });
        if (others === 0)
          throw new AppError(
            HttpStatus.CONFLICT,
            'last_admin',
            'The platform needs at least one administrator',
          );
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

  async putSetting(
    actorId: string,
    key: string,
    value: Prisma.InputJsonValue,
    description: string | undefined,
    why: Reason,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.setting.findUnique({ where: { key } });
      const setting = await tx.setting.upsert({
        where: { key },
        update: { value, description, updatedByUserId: actorId },
        create: { key, value, description, updatedByUserId: actorId },
      });
      await this.audit(tx, actorId, 'setting.put', 'setting', key, why, {
        before: before?.value ?? null,
        after: value,
      });
      return setting;
    });
  }

  listFlags() {
    return this.prisma.featureFlag.findMany({ orderBy: { key: 'asc' } });
  }

  async putFlag(
    actorId: string,
    key: string,
    enabled: boolean,
    organizationIds: string[],
    description: string | undefined,
    why: Reason,
  ) {
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
    return Object.fromEntries(
      flags.map((f) => [
        f.key,
        f.enabled || (!!organizationId && f.organizationIds.includes(organizationId)),
      ]),
    );
  }

  // ---- Module entitlements (PRD addendum 2.10) --------------------------------------

  modules() {
    return MODULES;
  }

  /**
   * Effective modules for an organization: core always; then its own entitlement; then what
   * admins set for its business type; then the module's default for that type.
   */
  async entitlements(organizationId: string) {
    const [rows, org] = await Promise.all([
      this.prisma.entitlement.findMany({ where: { organizationId } }),
      this.organizations.getOrganization(organizationId).catch(() => null),
    ]);
    const typeRows = org
      ? await this.prisma.businessTypeModule.findMany({ where: { organizationType: org.type } })
      : [];
    const now = new Date();
    const byKey = new Map(rows.map((r) => [r.moduleKey, r]));
    const byType = new Map(typeRows.map((r) => [r.moduleKey, r.enabled]));
    const modules: Record<string, boolean> = {};
    const details = MODULES.map((m) => {
      const row = byKey.get(m.key);
      const live = row && (!row.validUntil || row.validUntil > now);
      const forType = byType.get(m.key) ?? moduleDefault(m, org?.type);
      const enabled = m.core || (live ? row.enabled : forType);
      modules[m.key] = enabled;
      return {
        ...m,
        enabled,
        typeDefault: m.core || forType,
        override: live ? { enabled: row.enabled, validUntil: row.validUntil, note: row.note } : null,
      };
    });
    return { organizationId, organizationType: org?.type ?? null, modules, details };
  }

  /** The business type × module grid admins edit (drives every organization's sidebar). */
  async businessTypes() {
    const rows = await this.prisma.businessTypeModule.findMany();
    const set = new Map(rows.map((r) => [`${r.organizationType}|${r.moduleKey}`, r.enabled]));
    return {
      types: BUSINESS_TYPES,
      modules: MODULES,
      matrix: Object.fromEntries(
        BUSINESS_TYPES.map((t) => [
          t,
          Object.fromEntries(
            MODULES.map((m) => [
              m.key,
              {
                enabled: m.core || (set.get(`${t}|${m.key}`) ?? moduleDefault(m, t)),
                custom: set.has(`${t}|${m.key}`),
              },
            ]),
          ),
        ]),
      ),
    };
  }

  async setBusinessTypeModule(
    actorId: string,
    type: string,
    moduleKey: string,
    enabled: boolean | null,
    why: Reason,
  ) {
    if (!(BUSINESS_TYPES as readonly string[]).includes(type))
      throw badRequest('unknown_type', 'Unknown business type');
    const module = MODULES.find((m) => m.key === moduleKey);
    if (!module) throw badRequest('unknown_module', 'Unknown module');
    if (module.core) throw conflict('core_module', 'Core modules are always on');
    return this.prisma.$transaction(async (tx) => {
      const key = { organizationType_moduleKey: { organizationType: type, moduleKey } };
      const before = await tx.businessTypeModule.findUnique({ where: key });
      if (enabled === null) {
        if (before) await tx.businessTypeModule.delete({ where: key });
      } else {
        await tx.businessTypeModule.upsert({
          where: key,
          update: { enabled, updatedByUserId: actorId },
          create: { organizationType: type, moduleKey, enabled, updatedByUserId: actorId },
        });
      }
      await this.audit(tx, actorId, 'business_type.module', 'business_type', type, why, {
        module: moduleKey,
        before: before?.enabled ?? null,
        after: enabled,
      });
      return { type, moduleKey, enabled: enabled ?? moduleDefault(module, type) };
    });
  }

  async setEntitlement(
    actorId: string,
    organizationId: string,
    moduleKey: string,
    enabled: boolean,
    validUntil: string | null,
    why: Reason,
  ) {
    const module = MODULES.find((m) => m.key === moduleKey);
    if (!module) throw badRequest('unknown_module', 'Unknown module');
    if (module.core) throw conflict('core_module', 'Core modules are always on');
    if (!(await this.organizations.getOrganization(organizationId))) throw notFound('Organization');
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.entitlement.findUnique({
        where: { organizationId_moduleKey: { organizationId, moduleKey } },
      });
      const row = await tx.entitlement.upsert({
        where: { organizationId_moduleKey: { organizationId, moduleKey } },
        update: {
          enabled,
          validUntil: validUntil ? new Date(validUntil) : null,
          note: why.reason,
          updatedByUserId: actorId,
        },
        create: {
          organizationId,
          moduleKey,
          enabled,
          validUntil: validUntil ? new Date(validUntil) : null,
          note: why.reason,
          updatedByUserId: actorId,
        },
      });
      await this.audit(tx, actorId, 'entitlement.put', 'organization', organizationId, why, {
        module: moduleKey,
        before: before
          ? { enabled: before.enabled, validUntil: before.validUntil?.toISOString() ?? null }
          : null,
        after: { enabled, validUntil },
      });
      await emitEvent(tx, SERVICE_NAME, 'EntitlementChanged', organizationId, {
        organizationId,
        moduleKey,
        enabled,
        validUntil,
      });
      return row;
    });
  }

  /** Back to the module's default. */
  async clearEntitlement(actorId: string, organizationId: string, moduleKey: string, why: Reason) {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.entitlement.findUnique({
        where: { organizationId_moduleKey: { organizationId, moduleKey } },
      });
      if (!before) return { cleared: false };
      await tx.entitlement.delete({ where: { organizationId_moduleKey: { organizationId, moduleKey } } });
      await this.audit(tx, actorId, 'entitlement.clear', 'organization', organizationId, why, {
        module: moduleKey,
        before: { enabled: before.enabled },
      });
      const def = MODULES.find((m) => m.key === moduleKey);
      await emitEvent(tx, SERVICE_NAME, 'EntitlementChanged', organizationId, {
        organizationId,
        moduleKey,
        enabled: Boolean(def?.defaultEnabled),
        validUntil: null,
      });
      return { cleared: true };
    });
  }

  // ---- Controlled workflows -----------------------------------------------------

  /** Suspension goes through Organization's own API, so its data and events stay its own (PRD 4.2). */
  async setOrganizationStatus(
    actorId: string,
    organizationId: string,
    status: 'active' | 'suspended',
    why: Reason,
  ) {
    const before = await this.organizations.getOrganization(organizationId);
    if (!before) throw notFound('Organization');
    if (before.status === status) throw conflict('no_change', `The organization is already ${status}`);
    const after = await this.organizations.setStatus(organizationId, status);
    await this.audit(
      this.prisma,
      actorId,
      status === 'suspended' ? 'organization.suspend' : 'organization.reinstate',
      'organization',
      organizationId,
      why,
      {
        before: before.status,
        after: after.status,
      },
    );
    return after;
  }

  async listAudit(query: AuditQueryDto) {
    const where = this.auditWhere(query);
    const [items, total] = await Promise.all([
      this.prisma.auditEntry.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(query) }),
      this.prisma.auditEntry.count({ where }),
    ]);
    return toPage(items, total, query);
  }

  /** Distinct actions, target types and reason codes in the log (for filter menus). */
  async auditFacets() {
    const [actions, targetTypes, reasonCodes] = await Promise.all([
      this.prisma.auditEntry.groupBy({ by: ['action'], _count: { _all: true }, orderBy: { action: 'asc' } }),
      this.prisma.auditEntry.groupBy({
        by: ['targetType'],
        _count: { _all: true },
        orderBy: { targetType: 'asc' },
      }),
      this.prisma.auditEntry.groupBy({
        by: ['reasonCode'],
        _count: { _all: true },
        orderBy: { reasonCode: 'asc' },
      }),
    ]);
    return {
      actions: actions.map((r) => ({ value: r.action, count: r._count._all })),
      targetTypes: targetTypes.map((r) => ({ value: r.targetType, count: r._count._all })),
      reasonCodes: reasonCodes.map((r) => ({ value: r.reasonCode, count: r._count._all })),
    };
  }

  private auditWhere(q: AuditQueryDto): Prisma.AuditEntryWhereInput {
    const from = q.from ? new Date(q.from) : undefined;
    const to = q.to ? new Date(new Date(q.to).getTime() + 86_400_000) : undefined;
    if (from && to && from >= to) throw badRequest('invalid_range', '`from` must not be after `to`');
    return {
      ...(q.targetType ? { targetType: q.targetType } : {}),
      ...(q.targetId ? { targetId: q.targetId } : {}),
      ...(q.action ? { action: q.action } : {}),
      ...(q.actorUserId ? { actorUserId: q.actorUserId } : {}),
      ...(q.reasonCode ? { reasonCode: q.reasonCode } : {}),
      ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}),
      ...(q.q
        ? {
            OR: [
              { reason: { contains: q.q, mode: 'insensitive' } },
              { targetId: { contains: q.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
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
    return db.auditEntry.create({
      data: {
        actorUserId,
        action,
        targetType,
        targetId,
        reasonCode: why.reasonCode,
        reason: why.reason,
        details,
      },
    });
  }
}
