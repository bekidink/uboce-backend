import { applyDecorators, type CanActivate, type ExecutionContext, Inject, Injectable, Logger, SetMetadata, UseGuards } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AppError } from '../errors.js';
import { ORGANIZATION_HEADER } from './acting-organization.js';
import { AdministrationClient } from './clients.js';

export const MODULE_KEY = 'uboce:module';
const TTL_MS = 30_000;
const cache = new Map<string, { at: number; modules: Record<string, boolean> }>();

/**
 * Module entitlements (PRD addendum 2.10): the acting organization must have the module.
 * Checked with Administration and cached for 30 s; if Administration can't be reached the
 * request is allowed (entitlements are commercial gating, not a security boundary — roles are).
 */
@Injectable()
export class ModuleGuard implements CanActivate {
  private readonly logger = new Logger(ModuleGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(AdministrationClient) private readonly administration: AdministrationClient,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const moduleKey = this.reflector.getAllAndOverride<string>(MODULE_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!moduleKey) return true;
    const organizationId = ctx.switchToHttp().getRequest().headers[ORGANIZATION_HEADER];
    // No acting organization: ActsForOrganization (or the route) decides.
    if (typeof organizationId !== 'string' || !organizationId) return true;
    const modules = await this.modulesFor(organizationId);
    if (modules && modules[moduleKey] === false) {
      throw new AppError(403, 'module_not_enabled', `The ${moduleKey} module is not enabled for this organization`);
    }
    return true;
  }

  private async modulesFor(organizationId: string) {
    const hit = cache.get(organizationId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.modules;
    try {
      const { modules } = await this.administration.entitlements(organizationId);
      cache.set(organizationId, { at: Date.now(), modules });
      return modules;
    } catch (error) {
      this.logger.warn(`Entitlements unavailable for ${organizationId}: ${(error as Error).message}`);
      return hit?.modules ?? null;
    }
  }
}

/** Requires the acting organization to be entitled to `moduleKey`. */
export const RequiresModule = (moduleKey: string) => applyDecorators(SetMetadata(MODULE_KEY, moduleKey), UseGuards(ModuleGuard));
