import { createHash, randomBytes } from 'node:crypto';

import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  AppError,
  badRequest,
  conflict,
  forbidden,
  IdentityClient,
  MessagesClient,
  notFound,
  type PaginationQueryDto,
  skipTake,
  toPage,
} from '@uboce/common';

import { env } from '../config.js';
import type { Invitation } from '../generated/prisma/client.js';
import { OrganizationsService } from '../organizations/organizations.service.js';
import { canAssignRole } from '../organizations/permissions.js';
import { PrismaService } from '../prisma.service.js';
import type { CreateInvitationDto } from './invitations.dto.js';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

const invalidInvitation = () =>
  new AppError(HttpStatus.BAD_REQUEST, 'invalid_invitation', 'This invitation is invalid, expired or already used');

/** Never return the token hash. */
const publicView = (invitation: Invitation): Omit<Invitation, 'tokenHash'> => {
  const { tokenHash, ...rest } = invitation;
  void tokenHash;
  return rest;
};

@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationsService,
    private readonly identity: IdentityClient,
    private readonly messages: MessagesClient,
  ) {}

  /** Invites someone by email or phone. They join only after accepting while signed in as that address. */
  async create(userId: string, organizationId: string, dto: CreateInvitationDto) {
    const actor = await this.organizations.authorize(organizationId, userId, 'members:manage');
    if (!canAssignRole(actor.role, dto.role)) throw forbidden('You cannot grant this role');
    if (!!dto.email === !!dto.phone) throw badRequest('email_or_phone', 'Invite by exactly one of email or phone');

    const email = dto.email?.trim().toLowerCase() ?? null;
    const phone = dto.phone ?? null;
    const pending = await this.prisma.invitation.findFirst({
      where: { organizationId, status: 'pending', expiresAt: { gt: new Date() }, ...(email ? { email } : { phone }) },
    });
    if (pending) throw conflict('invitation_pending', 'This person already has a pending invitation');

    const token = randomBytes(32).toString('base64url');
    const invitation = await this.prisma.invitation.create({
      data: {
        organizationId,
        email,
        phone,
        role: dto.role,
        tokenHash: hashToken(token),
        invitedByUserId: userId,
        expiresAt: new Date(Date.now() + env.INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000),
      },
      include: { organization: true },
    });

    try {
      const [inviter, recipient] = await Promise.all([
        this.identity.getUser(userId),
        email ? this.identity.findByEmail(email) : Promise.resolve(null),
      ]);
      await this.messages.send({
        channel: email ? 'email' : 'sms',
        to: (email ?? phone)!,
        template: 'organization_invitation',
        locale: recipient?.locale ?? 'en',
        userId: recipient?.id,
        vars: {
          organizationName: invitation.organization.name,
          inviterName: inviter?.displayName ?? 'A colleague',
          role: dto.role,
          link: `${env.APP_BASE_URL}/invitations/accept?token=${token}`,
        },
      });
    } catch (error) {
      // An invitation nobody received is useless; remove it so it can be retried cleanly.
      await this.prisma.invitation.delete({ where: { id: invitation.id } });
      this.logger.error(`Invitation delivery failed: ${error}`);
      throw new AppError(HttpStatus.BAD_GATEWAY, 'delivery_failed', 'The invitation could not be sent; try again');
    }

    const { organization: _, ...rest } = invitation;
    return publicView(rest);
  }

  async list(userId: string, organizationId: string, query: PaginationQueryDto) {
    await this.organizations.authorize(organizationId, userId, 'members:read');
    const where = { organizationId, status: 'pending' as const, expiresAt: { gt: new Date() } };
    const [items, total] = await Promise.all([
      this.prisma.invitation.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(query) }),
      this.prisma.invitation.count({ where }),
    ]);
    return toPage(items.map(publicView), total, query);
  }

  async revoke(userId: string, organizationId: string, invitationId: string) {
    await this.organizations.authorize(organizationId, userId, 'members:manage');
    const { count } = await this.prisma.invitation.updateMany({
      where: { id: invitationId, organizationId, status: 'pending' },
      data: { status: 'revoked', respondedAt: new Date() },
    });
    if (count === 0) throw notFound('Invitation');
  }

  /** The signed-in user must own the invited email/phone; the link alone isn't enough. */
  async accept(userId: string, token: string) {
    const invitation = await this.prisma.invitation.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { organization: true },
    });
    if (!invitation || invitation.status !== 'pending' || invitation.expiresAt <= new Date()) throw invalidInvitation();
    if (invitation.organization.status !== 'active') {
      throw new AppError(HttpStatus.FORBIDDEN, 'organization_inactive', 'This organization is not active');
    }

    const user = await this.identity.getUser(userId);
    const matches =
      !!user && (invitation.email ? user.email === invitation.email : !!invitation.phone && user.phone === invitation.phone);
    if (!matches) {
      throw new AppError(HttpStatus.FORBIDDEN, 'invitation_mismatch', 'This invitation was sent to a different email or phone');
    }

    const membership = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.invitation.updateMany({
        where: { id: invitation.id, status: 'pending' },
        data: { status: 'accepted', acceptedByUserId: userId, respondedAt: new Date() },
      });
      if (count === 0) throw invalidInvitation();
      return this.organizations.addMembershipTx(tx, invitation.organizationId, userId, invitation.role, invitation.invitedByUserId);
    });
    return { membership, organization: invitation.organization };
  }
}
