import type { DynamicModule, Type } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { AuthModule } from './auth/auth.module.js';
import { type BaseEnv, decodeBase64, type InternalCallsEnv, internalModuleOptions } from './env.js';
import { REDIS, RedisModule } from './events/redis.module.js';
import { HealthModule } from './health.js';
import { InternalModule } from './internal/internal.module.js';
import { createLoggerModule } from './logging.js';

export interface CoreModulesOptions {
  serviceName: string;
  env: BaseEnv & Partial<InternalCallsEnv>;
  /** The service's PrismaService class; must be provided by a @Global module in `prismaModule`. */
  prismaService: Type<{ $queryRaw: (query: TemplateStringsArray) => Promise<unknown> }>;
  prismaModule: Type<unknown>;
}

/**
 * The modules every service needs, wired the same way everywhere: logging,
 * its database, Redis, the global auth guard, health checks, and (when
 * configured) service-to-service clients.
 */
export function coreModules({ serviceName, env, prismaService, prismaModule }: CoreModulesOptions): (DynamicModule | Type<unknown>)[] {
  const modules: (DynamicModule | Type<unknown>)[] = [
    createLoggerModule(serviceName, env.LOG_LEVEL),
    prismaModule,
    RedisModule.forRoot(env.REDIS_URL),
    AuthModule.forRootAsync({
      useFactory: (redis: Redis) => ({
        publicKeyPem: decodeBase64(env.JWT_PUBLIC_KEY),
        issuer: env.JWT_ISSUER,
        audience: env.JWT_AUDIENCE,
        redis,
      }),
      inject: [REDIS],
    }),
    HealthModule.forRootAsync({
      useFactory: (prisma: InstanceType<typeof prismaService>, redis: Redis) => ({
        database: () => prisma.$queryRaw`SELECT 1`,
        redis: () => redis.ping(),
      }),
      inject: [prismaService, REDIS],
    }),
  ];
  if (env.SERVICE_CLIENT_ID && env.SERVICE_CLIENT_SECRET && env.IDENTITY_URL) {
    modules.push(InternalModule.forRoot(internalModuleOptions(env as InternalCallsEnv)));
  }
  return modules;
}
