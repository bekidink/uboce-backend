import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AppError,
  badRequest,
  buildEvent,
  conflict,
  forbidden,
  IdentityClient,
  notFound,
  type PaginationQueryDto,
  skipTake,
  toOutboxRow,
  toPage,
} from '@uboce/common';
import { type EventCatalog, type EventType, PERMISSIONS } from '@uboce/contracts';

import { SERVICE_NAME } from '../config.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { Membership, MembershipRole, MembershipStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma.service.js';
import type {
  AddMemberDto,
  CreateBranchDto,
  CreateOrganizationDto,
  MemberLocationsDto,
  MemberTemplateDto,
  RoleTemplateDto,
  UpdateBranchDto,
  UpdateMemberDto,
  UpdateOrganizationDto,
} from './organizations.dto.js';
import { canAssignRole, hasPermission, type Permission, ROLE_PERMISSIONS } from './permissions.js';

type Tx = Prisma.TransactionClient;

const PERMISSION_KEYS = new Set<string>(PERMISSIONS.map((p) => p.key));

/** Members that still hold a seat: suspended ones keep role and scope but have no access. */
const SEATED: { in: MembershipStatus[] } = { in: ['active', 'suspended'] };

const lastOwner = () =>
  new AppError(HttpStatus.CONFLICT, 'last_owner', 'An organization must keep at least one owner');

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly identity: IdentityClient,
  ) {}

  directory(ids: string[]) {
    return this.prisma.organization.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, type: true, countryCode: true, status: true, verificationStatus: true },
    });
  }

  async create(userId: string, dto: CreateOrganizationDto) {
    return this.prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({
        data: {
          name: dto.name.trim(),
          legalName: dto.legalName?.trim(),
          type: dto.type,
          countryCode: dto.countryCode ?? 'ET',
          businessModels: dto.businessModels,
          contactPhone: dto.contactPhone,
          contactEmail: dto.contactEmail,
          createdByUserId: userId,
        },
      });
      const membership = await tx.membership.create({
        data: { organizationId: organization.id, userId, role: 'owner', addedByUserId: userId },
      });
      await this.emit(tx, 'OrganizationCreated', organization.id, {
        organizationId: organization.id,
        name: organization.name,
        type: organization.type,
        countryCode: organization.countryCode,
        createdByUserId: userId,
      });
      await this.emitMembershipAdded(tx, membership, userId);
      return organization;
    });
  }

  /** Organizations the caller actively belongs to, with their role in each. */
  async listMine(userId: string, query: PaginationQueryDto) {
    const where = { userId, status: 'active' } as const;
    const [memberships, total] = await Promise.all([
      this.prisma.membership.findMany({
        where,
        include: { organization: true },
        orderBy: { createdAt: 'desc' },
        ...skipTake(query),
      }),
      this.prisma.membership.count({ where }),
    ]);
    return toPage(
      memberships.map((m) => ({ ...m.organization, membership: { id: m.id, role: m.role } })),
      total,
      query,
    );
  }

  async get(userId: string, organizationId: string) {
    await this.authorize(organizationId, userId, 'organization:read');
    return this.prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
  }

  /** The caller's role and permissions — lets clients and other services gate actions. */
  async myAccess(userId: string, organizationId: string) {
    const membership = await this.authorize(organizationId, userId, 'organization:read');
    const locations = await this.prisma.membershipLocation.findMany({ where: { membershipId: membership.id }, select: { branchId: true } });
    return {
      membershipId: membership.id,
      role: membership.role,
      permissions: ROLE_PERMISSIONS[membership.role],
      locationIds: locations.map((l) => l.branchId),
    };
  }

  async update(userId: string, organizationId: string, dto: UpdateOrganizationDto) {
    await this.authorize(organizationId, userId, 'organization:update');
    return this.prisma.$transaction(async (tx) => {
      const organization = await tx.organization.update({
        where: { id: organizationId },
        data: {
          name: dto.name?.trim(),
          legalName: dto.legalName?.trim(),
          businessModels: dto.businessModels,
          contactPhone: dto.contactPhone,
          contactEmail: dto.contactEmail,
        },
      });
      await this.emit(tx, 'OrganizationUpdated', organization.id, {
        organizationId: organization.id,
        name: organization.name,
        type: organization.type,
        countryCode: organization.countryCode,
        status: organization.status,
        verificationStatus: organization.verificationStatus,
      });
      return organization;
    });
  }

  async listMembers(userId: string, organizationId: string, query: PaginationQueryDto) {
    await this.authorize(organizationId, userId, 'members:read');
    const where = { organizationId, status: SEATED };
    const [rows, total] = await Promise.all([
      this.prisma.membership.findMany({
        where,
        include: { locations: { select: { branchId: true } } },
        orderBy: { createdAt: 'asc' },
        ...skipTake(query),
      }),
      this.prisma.membership.count({ where }),
    ]);
    const items = rows.map(({ locations, ...m }) => ({ ...m, locationIds: locations.map((l) => l.branchId) }));
    const users = await Promise.all(items.map((m) => this.identity.getUser(m.userId)));
    const withUsers = items.map((m, i) => ({
      ...m,
      user: users[i] ? { displayName: users[i].displayName, email: users[i].email } : null,
    }));
    return toPage(withUsers, total, query);
  }

  async addMember(userId: string, organizationId: string, dto: AddMemberDto) {
    const actor = await this.authorize(organizationId, userId, 'members:manage');
    if (!canAssignRole(actor.role, dto.role)) throw forbidden('You cannot grant this role');

    return this.prisma.$transaction((tx) => this.addMembershipTx(tx, organizationId, dto.userId, dto.role, userId));
  }

  /** Adds (or reactivates) a membership and emits MembershipAdded. Also used when an invitation is accepted. */
  async addMembershipTx(tx: Tx, organizationId: string, memberUserId: string, role: MembershipRole, addedByUserId: string) {
    const existing = await tx.membership.findUnique({
      where: { organizationId_userId: { organizationId, userId: memberUserId } },
    });
    if (existing?.status === 'active' || existing?.status === 'suspended') {
      throw conflict('already_member', 'This user is already a member');
    }

    // Re-adding a former member reactivates their row so history stays in one place.
    const membership = existing
      ? await tx.membership.update({
          where: { id: existing.id },
          data: { status: 'active', role, addedByUserId, revokedAt: null, suspendedAt: null },
        })
      : await tx.membership.create({ data: { organizationId, userId: memberUserId, role, addedByUserId } });
    await this.emitMembershipAdded(tx, membership, addedByUserId);
    return membership;
  }

  async updateMember(userId: string, organizationId: string, membershipId: string, dto: UpdateMemberDto) {
    const actor = await this.authorize(organizationId, userId, 'members:manage');
    const target = await this.activeMembership(organizationId, membershipId);
    if (!canAssignRole(actor.role, dto.role) || !canAssignRole(actor.role, target.role)) {
      throw forbidden('You cannot change this member to or from that role');
    }

    return this.prisma.$transaction(async (tx) => {
      if (target.role === 'owner' && dto.role !== 'owner') await this.assertAnotherOwner(tx, organizationId, target.id);
      if (dto.role === 'owner') await tx.membershipLocation.deleteMany({ where: { membershipId: target.id } });
      const updated = await tx.membership.update({ where: { id: target.id }, data: { role: dto.role } });
      await this.emitMembershipUpdated(tx, updated, userId);
      return updated;
    });
  }

  /** Suspends (true) or reactivates (false) a member; the last active owner can't be suspended. */
  async setSuspended(userId: string, organizationId: string, membershipId: string, suspended: boolean) {
    const actor = await this.authorize(organizationId, userId, 'members:manage');
    const target = await this.activeMembership(organizationId, membershipId);
    if (target.userId === userId) throw forbidden('You cannot suspend or reactivate yourself');
    if (!canAssignRole(actor.role, target.role)) throw forbidden('You cannot change this member');
    if ((target.status === 'suspended') === suspended) return target;

    return this.prisma.$transaction(async (tx) => {
      if (suspended && target.role === 'owner') await this.assertAnotherOwner(tx, organizationId, target.id);
      const updated = await tx.membership.update({
        where: { id: target.id },
        data: suspended ? { status: 'suspended', suspendedAt: new Date() } : { status: 'active', suspendedAt: null },
      });
      await this.emitMembershipUpdated(tx, updated, userId);
      return updated;
    });
  }

  // ---- Role templates (PRD addendum 2.2) ----------------------------------------------

  async listTemplates(userId: string, organizationId: string) {
    await this.authorize(organizationId, userId, 'members:read');
    return this.prisma.roleTemplate.findMany({ where: { organizationId }, include: { _count: { select: { memberships: true } } }, orderBy: { name: 'asc' } });
  }

  async saveTemplate(userId: string, organizationId: string, dto: RoleTemplateDto, templateId?: string) {
    await this.authorize(organizationId, userId, 'members:manage');
    const unknown = dto.permissions.filter((p) => !PERMISSION_KEYS.has(p));
    if (unknown.length) throw badRequest('unknown_permission', `Unknown permissions: ${unknown.join(', ')}`);
    if (Boolean(dto.approvalLimit) !== Boolean(dto.approvalCurrency)) throw badRequest('limit_currency', 'An approval limit needs a currency (and only then)');
    const data = {
      name: dto.name.trim(),
      description: dto.description?.trim() || null,
      permissions: dto.permissions,
      approvalLimit: dto.approvalLimit ?? null,
      approvalCurrency: dto.approvalCurrency ?? null,
    };
    try {
      if (!templateId) return await this.prisma.roleTemplate.create({ data: { ...data, organizationId } });
      const existing = await this.prisma.roleTemplate.findFirst({ where: { id: templateId, organizationId } });
      if (!existing) throw notFound('Role template');
      return await this.prisma.roleTemplate.update({ where: { id: templateId }, data });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') throw conflict('name_taken', 'Another template has that name');
      throw error;
    }
  }

  async deleteTemplate(userId: string, organizationId: string, templateId: string) {
    await this.authorize(organizationId, userId, 'members:manage');
    const template = await this.prisma.roleTemplate.findFirst({ where: { id: templateId, organizationId }, include: { _count: { select: { memberships: true } } } });
    if (!template) throw notFound('Role template');
    if (template._count.memberships) throw conflict('template_in_use', 'Remove the template from its members first');
    await this.prisma.roleTemplate.delete({ where: { id: templateId } });
  }

  async setMemberTemplate(userId: string, organizationId: string, membershipId: string, dto: MemberTemplateDto) {
    const actor = await this.authorize(organizationId, userId, 'members:manage');
    const target = await this.activeMembership(organizationId, membershipId);
    if (!canAssignRole(actor.role, target.role)) throw forbidden('You cannot change this member');
    if (target.role === 'owner' && dto.roleTemplateId) throw forbidden('Owners are never limited by a template');
    if (dto.roleTemplateId && !(await this.prisma.roleTemplate.findFirst({ where: { id: dto.roleTemplateId, organizationId } }))) throw notFound('Role template');
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.membership.update({ where: { id: target.id }, data: { roleTemplateId: dto.roleTemplateId ?? null } });
      await this.emitMembershipUpdated(tx, updated, userId);
      return updated;
    });
  }

  /** Limits a member to some locations; an empty list gives back the whole organization. */
  async setMemberLocations(userId: string, organizationId: string, membershipId: string, dto: MemberLocationsDto) {
    const actor = await this.authorize(organizationId, userId, 'members:manage');
    const target = await this.activeMembership(organizationId, membershipId);
    if (!canAssignRole(actor.role, target.role)) throw forbidden('You cannot change this member');
    if (target.role === 'owner' && dto.branchIds.length) throw forbidden('Owners always cover the whole organization');
    const found = await this.prisma.branch.count({ where: { organizationId, id: { in: dto.branchIds } } });
    if (found !== dto.branchIds.length) throw notFound('Location');

    return this.prisma.$transaction(async (tx) => {
      await tx.membershipLocation.deleteMany({ where: { membershipId: target.id } });
      if (dto.branchIds.length) {
        await tx.membershipLocation.createMany({ data: dto.branchIds.map((branchId) => ({ membershipId: target.id, branchId })) });
      }
      await this.emitMembershipUpdated(tx, target, userId);
      return { ...target, locationIds: dto.branchIds };
    });
  }

  /** Removes a member. Members can always remove themselves (leave), except the last owner. */
  async revokeMember(userId: string, organizationId: string, membershipId: string) {
    const actor = await this.authorize(organizationId, userId, 'organization:read');
    const target = await this.activeMembership(organizationId, membershipId);
    const leaving = target.userId === userId;
    if (!leaving && !canAssignRole(actor.role, target.role)) throw forbidden('You cannot remove this member');

    await this.prisma.$transaction(async (tx) => {
      if (target.role === 'owner') await this.assertAnotherOwner(tx, organizationId, target.id);
      await tx.membership.update({ where: { id: target.id }, data: { status: 'revoked', revokedAt: new Date() } });
      await this.emit(tx, 'MembershipRevoked', organizationId, {
        organizationId,
        membershipId: target.id,
        userId: target.userId,
        revokedByUserId: userId,
      });
    });
  }

  async createBranch(userId: string, organizationId: string, dto: CreateBranchDto) {
    await this.authorize(organizationId, userId, 'branches:manage');
    const { operatingHours, ...rest } = dto;
    return this.prisma.$transaction(async (tx) => {
      const branch = await tx.branch.create({
        data: { ...rest, operatingHours: hours(operatingHours) ?? [], countryCode: dto.countryCode ?? 'ET', organizationId },
      });
      await this.emitLocations(tx, organizationId);
      return branch;
    });
  }

  /** Active organizations of a type, e.g. logistics providers, with where they operate. */
  async providers(type: string, q?: string, area?: string) {
    const types = ['business', 'cooperative', 'farm', 'manufacturer', 'wholesaler', 'distributor', 'warehouse', 'logistics_provider', 'other'];
    if (!types.includes(type)) throw badRequest('invalid_type', 'Unknown organization type');
    const orgs = await this.prisma.organization.findMany({
      where: {
        type: type as never,
        status: 'active',
        ...(q ? { name: { contains: q.trim(), mode: 'insensitive' as const } } : {}),
        ...(area ? { branches: { some: { active: true, serviceAreas: { has: area.trim() } } } } : {}),
      },
      include: { branches: { where: { active: true }, select: { city: true, serviceAreas: true } } },
      orderBy: [{ verificationStatus: 'asc' }, { name: 'asc' }],
      take: 50,
    });
    return orgs.map((o) => ({
      id: o.id,
      name: o.name,
      type: o.type,
      verificationStatus: o.verificationStatus,
      contactPhone: o.contactPhone,
      contactEmail: o.contactEmail,
      cities: [...new Set(o.branches.map((b) => b.city).filter(Boolean))],
      serviceAreas: [...new Set(o.branches.flatMap((b) => b.serviceAreas))],
    }));
  }

  publicLocations(organizationId: string) {
    return this.prisma.branch.findMany({
      where: { organizationId, active: true },
      select: { id: true, name: true, kind: true, city: true, region: true, addressLine: true, operatingHours: true, serviceAreas: true, pickupEnabled: true, phone: true },
      orderBy: { name: 'asc' },
    });
  }

  async getBranch(userId: string, organizationId: string, branchId: string) {
    await this.authorize(organizationId, userId, 'organization:read');
    const branch = await this.prisma.branch.findFirst({ where: { id: branchId, organizationId } });
    if (!branch) throw notFound('Location');
    return branch;
  }

  async updateBranch(userId: string, organizationId: string, branchId: string, dto: UpdateBranchDto) {
    await this.authorize(organizationId, userId, 'branches:manage');
    const branch = await this.prisma.branch.findFirst({ where: { id: branchId, organizationId } });
    if (!branch) throw notFound('Location');
    const { operatingHours, ...rest } = dto;
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.branch.update({ where: { id: branch.id }, data: { ...rest, operatingHours: hours(operatingHours) } });
      await this.emitLocations(tx, organizationId);
      return updated;
    });
  }

  /** Search needs where an organization delivers and where buyers can collect. */
  private async emitLocations(tx: Tx, organizationId: string) {
    const branches = await tx.branch.findMany({ where: { organizationId, active: true } });
    const serviceAreas = [...new Set(branches.flatMap((b) => b.serviceAreas.map((a) => a.trim()).filter(Boolean)))];
    const pickupCities = [...new Set(branches.filter((b) => b.pickupEnabled && b.city).map((b) => b.city!))];
    await this.emit(tx, 'OrganizationLocationsChanged', organizationId, { organizationId, serviceAreas, pickupCities });
  }

  async listBranches(userId: string, organizationId: string, query: PaginationQueryDto) {
    await this.authorize(organizationId, userId, 'organization:read');
    const where = { organizationId };
    const [items, total] = await Promise.all([
      this.prisma.branch.findMany({ where, orderBy: { createdAt: 'asc' }, ...skipTake(query) }),
      this.prisma.branch.count({ where }),
    ]);
    return toPage(items, total, query);
  }

  /**
   * Resolves the caller's active membership and checks the permission (PRD 3.2).
   * Non-members get 404, not 403, so organization IDs can't be probed.
   */
  async authorize(organizationId: string, userId: string, permission: Permission): Promise<Membership> {
    const membership = await this.prisma.membership.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
      include: { organization: { select: { status: true } } },
    });
    if (!membership || membership.status === 'revoked') throw notFound('Organization');
    if (membership.status === 'suspended') {
      throw new AppError(HttpStatus.FORBIDDEN, 'membership_suspended', 'Your access to this organization is suspended');
    }
    if (!hasPermission(membership.role, permission)) throw forbidden();
    if (membership.organization.status !== 'active' && permission !== 'organization:read' && permission !== 'members:read') {
      throw new AppError(HttpStatus.FORBIDDEN, 'organization_inactive', 'This organization is not active');
    }
    return membership;
  }

  private async activeMembership(organizationId: string, membershipId: string) {
    const membership = await this.prisma.membership.findFirst({
      where: { id: membershipId, organizationId, status: SEATED },
    });
    if (!membership) throw notFound('Member');
    return membership;
  }

  private async assertAnotherOwner(tx: Tx, organizationId: string, excludingMembershipId: string) {
    const owners = await tx.membership.count({
      where: { organizationId, role: 'owner' satisfies MembershipRole, status: 'active', id: { not: excludingMembershipId } },
    });
    if (owners === 0) throw lastOwner();
  }

  private emitMembershipAdded(tx: Tx, membership: Membership, addedByUserId: string) {
    return this.emit(tx, 'MembershipAdded', membership.organizationId, {
      organizationId: membership.organizationId,
      membershipId: membership.id,
      userId: membership.userId,
      role: membership.role,
      addedByUserId,
    });
  }

  private async emitMembershipUpdated(tx: Tx, membership: Membership, changedByUserId: string) {
    const locations = await tx.membershipLocation.findMany({ where: { membershipId: membership.id }, select: { branchId: true } });
    return this.emit(tx, 'MembershipUpdated', membership.organizationId, {
      organizationId: membership.organizationId,
      membershipId: membership.id,
      userId: membership.userId,
      role: membership.role,
      status: membership.status,
      locationIds: locations.map((l) => l.branchId),
      changedByUserId,
    });
  }

  private emit<T extends EventType>(tx: Tx, type: T, aggregateId: string, data: EventCatalog[T]) {
    return tx.outboxEvent.create({ data: toOutboxRow(buildEvent(SERVICE_NAME, type, aggregateId, data)) });
  }
}

/** Sorted, JSON-ready weekly hours (undefined leaves them unchanged). */
const hours = (h: UpdateBranchDto['operatingHours']) =>
  h?.map(({ day, opens, closes }) => ({ day, opens, closes })).sort((a, b) => a.day - b.day || a.opens.localeCompare(b.opens));
