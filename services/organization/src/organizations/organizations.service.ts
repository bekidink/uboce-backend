import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AppError,
  buildEvent,
  conflict,
  forbidden,
  notFound,
  type PaginationQueryDto,
  skipTake,
  toOutboxRow,
  toPage,
} from '@uboce/common';
import type { EventCatalog, EventType } from '@uboce/contracts';

import { SERVICE_NAME } from '../config.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { Membership, MembershipRole } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma.service.js';
import type {
  AddMemberDto,
  CreateBranchDto,
  CreateOrganizationDto,
  UpdateMemberDto,
  UpdateOrganizationDto,
} from './organizations.dto.js';
import { canAssignRole, hasPermission, type Permission, ROLE_PERMISSIONS } from './permissions.js';

type Tx = Prisma.TransactionClient;

const lastOwner = () =>
  new AppError(HttpStatus.CONFLICT, 'last_owner', 'An organization must keep at least one owner');

@Injectable()
export class OrganizationsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, dto: CreateOrganizationDto) {
    return this.prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({
        data: {
          name: dto.name.trim(),
          legalName: dto.legalName?.trim(),
          type: dto.type,
          countryCode: dto.countryCode ?? 'ET',
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
    return { membershipId: membership.id, role: membership.role, permissions: ROLE_PERMISSIONS[membership.role] };
  }

  async update(userId: string, organizationId: string, dto: UpdateOrganizationDto) {
    await this.authorize(organizationId, userId, 'organization:update');
    return this.prisma.$transaction(async (tx) => {
      const organization = await tx.organization.update({
        where: { id: organizationId },
        data: { name: dto.name?.trim(), legalName: dto.legalName?.trim() },
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
    const where = { organizationId, status: 'active' } as const;
    const [items, total] = await Promise.all([
      this.prisma.membership.findMany({ where, orderBy: { createdAt: 'asc' }, ...skipTake(query) }),
      this.prisma.membership.count({ where }),
    ]);
    return toPage(items, total, query);
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
    if (existing?.status === 'active') throw conflict('already_member', 'This user is already a member');

    // Re-adding a former member reactivates their row so history stays in one place.
    const membership = existing
      ? await tx.membership.update({
          where: { id: existing.id },
          data: { status: 'active', role, addedByUserId, revokedAt: null },
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
      return tx.membership.update({ where: { id: target.id }, data: { role: dto.role } });
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
    return this.prisma.branch.create({ data: { ...dto, countryCode: dto.countryCode ?? 'ET', organizationId } });
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
    if (!membership || membership.status !== 'active') throw notFound('Organization');
    if (!hasPermission(membership.role, permission)) throw forbidden();
    if (membership.organization.status !== 'active' && permission !== 'organization:read' && permission !== 'members:read') {
      throw new AppError(HttpStatus.FORBIDDEN, 'organization_inactive', 'This organization is not active');
    }
    return membership;
  }

  private async activeMembership(organizationId: string, membershipId: string) {
    const membership = await this.prisma.membership.findFirst({
      where: { id: membershipId, organizationId, status: 'active' },
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

  private emit<T extends EventType>(tx: Tx, type: T, aggregateId: string, data: EventCatalog[T]) {
    return tx.outboxEvent.create({ data: toOutboxRow(buildEvent(SERVICE_NAME, type, aggregateId, data)) });
  }
}
