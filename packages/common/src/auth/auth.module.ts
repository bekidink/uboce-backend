import {
  type CanActivate,
  type DynamicModule,
  type ExecutionContext,
  Global,
  Inject,
  Injectable,
  Module,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { AppError } from '../errors.js';
import { INTERNAL_CALLERS_KEY, IS_PUBLIC_KEY } from './decorators.js';
import { AccessTokenVerifier, type TokenVerifierOptions } from './token-verifier.js';

export const ACCESS_TOKEN_VERIFIER = Symbol('ACCESS_TOKEN_VERIFIER');

const bearer = (req: Request) => {
  const [scheme, token] = (req.headers.authorization ?? '').split(' ');
  if (scheme !== 'Bearer' || !token) throw new AppError(401, 'unauthorized', 'Missing bearer token');
  return token;
};

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(ACCESS_TOKEN_VERIFIER) private readonly verifier: AccessTokenVerifier,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: unknown; service?: unknown }>();
    const internalCallers = this.reflector.getAllAndOverride<string[] | undefined>(INTERNAL_CALLERS_KEY, targets);

    if (internalCallers) {
      const token = bearer(req);
      const caller = await this.verifier.verifyService(token).catch(() => {
        throw new AppError(401, 'unauthorized', 'Invalid service token');
      });
      if (internalCallers.length > 0 && !internalCallers.includes(caller.service)) {
        throw new AppError(403, 'forbidden', `Service ${caller.service} may not call this route`);
      }
      req.service = caller;
      return true;
    }

    const token = bearer(req);
    try {
      req.user = await this.verifier.verify(token);
      return true;
    } catch {
      throw new AppError(401, 'unauthorized', 'Invalid or expired access token');
    }
  }
}

export interface AuthModuleOptions {
  useFactory: (...deps: any[]) => TokenVerifierOptions | Promise<TokenVerifierOptions>;
  inject?: any[];
}

/** Registers the global AuthGuard: every route needs a valid token unless marked @Public(). */
@Global()
@Module({})
export class AuthModule {
  static forRootAsync(options: AuthModuleOptions): DynamicModule {
    return {
      module: AuthModule,
      providers: [
        {
          provide: ACCESS_TOKEN_VERIFIER,
          useFactory: async (...deps: unknown[]) => new AccessTokenVerifier(await options.useFactory(...deps)),
          inject: options.inject ?? [],
        },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
      exports: [ACCESS_TOKEN_VERIFIER],
    };
  }
}
