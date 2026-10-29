import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { emitEvent, Internal, notFound } from '@uboce/common';
import type { InternalBranch, InternalMembership, InternalOrganization, InternalOrganizationMember } from '@uboce/contracts';
import { IsEnum } from 'class-validator';

import { SERVICE_NAME } from '../config.js';
import type { Organization } from '../generated/prisma/client.js';
import { MembershipRole, OrganizationStatus } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma.service.js';

class StatusChangeDto {
  @IsEnum(OrganizationStatus)
  status: OrganizationStatus;
}

const ROLES = new Set<string>(Object.values(MembershipRole));

const toInternal = (o: Organization): InternalOrganization => ({
  id: o.id,
  name: o.name,
  type: o.type,
  countryCode: o.countryCode,
  status: o.status,
  verificationStatus: o.verificationStatus,
});

/** Lookups other services use to authorize organization-scoped actions. */
@ApiExcludeController()
@Controller('internal/organizations/:organizationId')
export class InternalController {
  constructor(private readonly prisma: PrismaService) {}

  /** Basic public facts about an organization, e.g. to check a counterparty exists and is active. */
  @Internal()
  @Get()
  async organization(@Param('organizationId', new ParseUUIDPipe()) organizationId: string): Promise<InternalOrganization> {
    const organization = await this.prisma.organization.findUnique({ where: { id: organizationId } });
    if (!organization) throw notFound('Organization');
    return toInternal(organization);
  }

  /** Suspension/reinstatement by platform administration; audited there, announced here. */
  @Internal('administration')
  @Post('status')
  @HttpCode(200)
  async setStatus(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Body() dto: StatusChangeDto,
  ): Promise<InternalOrganization> {
    const organization = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.organization.update({ where: { id: organizationId }, data: { status: dto.status } }).catch(() => {
        throw notFound('Organization');
      });
      await emitEvent(tx, SERVICE_NAME, 'OrganizationUpdated', updated.id, {
        organizationId: updated.id,
        name: updated.name,
        type: updated.type,
        countryCode: updated.countryCode,
        status: updated.status,
        verificationStatus: updated.verificationStatus,
      });
      return updated;
    });
    return toInternal(organization);
  }

  @Internal()
  @Get('branches/:branchId')
  async branch(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('branchId', new ParseUUIDPipe()) branchId: string,
  ): Promise<InternalBranch> {
    const branch = await this.prisma.branch.findFirst({ where: { id: branchId, organizationId } });
    if (!branch) throw notFound('Location');
    return {
      id: branch.id,
      organizationId: branch.organizationId,
      name: branch.name,
      kind: branch.kind,
      active: branch.active,
      pickupEnabled: branch.pickupEnabled,
      fulfillment: branch.fulfillment,
    };
  }

  @Internal()
  @Get('members/:userId')
  async membership(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ): Promise<InternalMembership> {
    const membership = await this.prisma.membership.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
      include: { organization: true, locations: { select: { branchId: true } }, roleTemplate: true },
    });
    // Suspended members are treated like non-members by every other service.
    if (!membership || membership.status !== 'active') throw notFound('Membership');
    return {
      membershipId: membership.id,
      userId: membership.userId,
      role: membership.role,
      locationIds: membership.locations.map((l) => l.branchId),
      permissions: membership.roleTemplate?.permissions ?? null,
      approvalLimit:
        membership.roleTemplate?.approvalLimit && membership.roleTemplate.approvalCurrency
          ? { amount: membership.roleTemplate.approvalLimit.toString(), currency: membership.roleTemplate.approvalCurrency }
          : null,
      organization: toInternal(membership.organization),
    };
  }

  /** Active members, optionally only some roles — e.g. who to notify about a new RFQ. */
  @Internal('notification')
  @Get('members')
  async members(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Query('roles') roles?: string,
  ): Promise<InternalOrganizationMember[]> {
    const wanted = (roles ?? '').split(',').filter((r) => ROLES.has(r)) as MembershipRole[];
    return this.prisma.membership.findMany({
      where: { organizationId, status: 'active', ...(wanted.length ? { role: { in: wanted } } : {}) },
      select: { userId: true, role: true },
      take: 500,
    });
  }
}
