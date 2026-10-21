import {
  applyDecorators,
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { AuthUser } from '../auth/token-verifier.js';
import { AppError } from '../errors.js';
import { AdministrationClient } from './clients.js';

export const PLATFORM_ROLES_KEY = 'uboce:platform-roles';

/** Platform-staff roles, granted and audited by the Administration service (S21). */
export type PlatformRole = 'platform_admin' | 'verification_reviewer' | 'dispute_reviewer' | 'support';

/**
 * Platform staff routes (verification review, dispute review, admin). The
 * caller needs one of `roles` (platform_admin always qualifies), checked live
 * with Administration on each request so revocation is immediate.
 */
@Injectable()
export class PlatformRoleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(AdministrationClient) private readonly administration: AdministrationClient,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<PlatformRole[]>(PLATFORM_ROLES_KEY, [ctx.getHandler(), ctx.getClass()]) ?? [];
    const req = ctx.switchToHttp().getRequest();
    const user = req.user as AuthUser;
    const roles = await this.administration.platformRoles(user.userId);
    if (!roles.includes('platform_admin') && !required.some((r) => roles.includes(r))) {
      throw new AppError(403, 'forbidden', 'This action is limited to platform staff');
    }
    req.platformRoles = roles;
    return true;
  }
}

export const RequiresPlatformRole = (...roles: PlatformRole[]) =>
  applyDecorators(SetMetadata(PLATFORM_ROLES_KEY, roles), UseGuards(PlatformRoleGuard));

export const PlatformRoles = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): string[] => ctx.switchToHttp().getRequest().platformRoles ?? [],
);
