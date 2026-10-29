import {
  applyDecorators,
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Inject,
  Injectable,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import type { InternalMembership } from '@uboce/contracts';

import type { AuthUser } from '../auth/token-verifier.js';
import { AppError } from '../errors.js';
import { OrganizationsClient } from './clients.js';

export const ORGANIZATION_HEADER = 'x-organization-id';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The organization the caller is acting for, verified against their real membership. */
export type ActingOrganization = InternalMembership;

/**
 * The client says which organization it is acting for; that claim is untrusted
 * until Organization confirms an active membership (PRD 3.2). Each service then
 * checks the returned role against its own permission rules.
 */
@Injectable()
export class ActingOrganizationGuard implements CanActivate {
  constructor(@Inject(OrganizationsClient) private readonly organizations: OrganizationsClient) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const organizationId = req.headers[ORGANIZATION_HEADER];
    if (typeof organizationId !== 'string' || !UUID.test(organizationId)) {
      throw new AppError(400, 'organization_required', `Send the acting organization's ID in the ${ORGANIZATION_HEADER} header`);
    }
    const user = req.user as AuthUser;
    const membership = await this.organizations.getMembership(organizationId, user.userId);
    if (!membership) throw new AppError(404, 'not_found', 'Organization not found');
    if (membership.organization.status !== 'active') {
      throw new AppError(403, 'organization_inactive', 'This organization is not active');
    }
    req.actingOrganization = membership;
    return true;
  }
}

/** Requires `x-organization-id` and resolves the caller's membership in it. */
export const ActsForOrganization = () =>
  applyDecorators(
    UseGuards(ActingOrganizationGuard),
    ApiHeader({ name: ORGANIZATION_HEADER, required: true, description: 'Organization the caller is acting for' }),
  );

export const ActingOrg = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): ActingOrganization => ctx.switchToHttp().getRequest().actingOrganization,
);

/** Throws 403 unless the acting role is one of `roles`. */
export function requireRole(org: ActingOrganization, roles: readonly string[], action: string) {
  if (!roles.includes(org.role)) {
    throw new AppError(403, 'forbidden', `Your role (${org.role}) cannot ${action}`);
  }
}

/**
 * Throws 403 unless the acting member may work at `locationId` (PRD addendum 2.2).
 * Members without location assignments cover the whole organization.
 */
export function requireLocation(org: ActingOrganization, locationId: string | null | undefined, action: string) {
  if (!locationId || !org.locationIds?.length) return;
  if (!org.locationIds.includes(locationId)) {
    throw new AppError(403, 'location_forbidden', `You are not assigned to this location and cannot ${action}`);
  }
}

/** The location filter for list queries: null when the member covers every location. */
export const locationScope = (org: ActingOrganization): string[] | null => (org.locationIds?.length ? org.locationIds : null);

/** Throws 403 unless the member's role template (if any) grants `permission` (PRD addendum 2.2). */
export function requirePermission(org: ActingOrganization, permission: string, action: string) {
  if (org.permissions && !org.permissions.includes(permission)) {
    throw new AppError(403, 'permission_denied', `Your role template does not allow you to ${action}`);
  }
}

/**
 * Approval limits (PRD addendum 2.2): a member whose template sets a limit can't approve more than it.
 * A limit in another currency can't be compared, so it doesn't authorize the amount either.
 */
export function requireApprovalLimit(org: ActingOrganization, amount: string | number, currency: string, action: string) {
  const limit = org.approvalLimit;
  if (!limit) return;
  if (limit.currency !== currency || Number(amount) > Number(limit.amount)) {
    throw new AppError(403, 'approval_limit_exceeded', `You can ${action} up to ${limit.amount} ${limit.currency}; ask someone with a higher limit`);
  }
}
