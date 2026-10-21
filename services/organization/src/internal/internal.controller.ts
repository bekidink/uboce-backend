import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Internal, notFound } from '@uboce/common';
import type { InternalMembership, InternalOrganization, InternalOrganizationMember } from '@uboce/contracts';

import type { Organization } from '../generated/prisma/client.js';
import { MembershipRole } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma.service.js';

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

  @Internal()
  @Get('members/:userId')
  async membership(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ): Promise<InternalMembership> {
    const membership = await this.prisma.membership.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
      include: { organization: true },
    });
    if (!membership || membership.status !== 'active') throw notFound('Membership');
    return {
      membershipId: membership.id,
      userId: membership.userId,
      role: membership.role,
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
