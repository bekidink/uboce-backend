import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';

import type { AuthUser, ServiceCaller } from './token-verifier.js';

export const IS_PUBLIC_KEY = 'uboce:public';
export const INTERNAL_CALLERS_KEY = 'uboce:internal-callers';

/** Opts a route out of the global AuthGuard. Everything is authenticated by default. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Marks a route as service-to-service only: it requires a service token (user
 * tokens are rejected), optionally from specific services. Keep these under
 * `internal/` so the gateway never exposes them.
 */
export const Internal = (...allowedServices: string[]) => {
  const setMeta = SetMetadata(INTERNAL_CALLERS_KEY, allowedServices);
  return (target: object, key?: string | symbol, descriptor?: PropertyDescriptor) => {
    setMeta(target, key as string, descriptor as PropertyDescriptor);
    if (descriptor) ApiExcludeEndpoint()(target, key as string, descriptor);
  };
};

/** The authenticated user resolved by AuthGuard. */
export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user,
);

/** The calling service on @Internal() routes. */
export const CallingService = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): ServiceCaller => ctx.switchToHttp().getRequest().service,
);
