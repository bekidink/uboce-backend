import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { coreModules, OutboxRelayHost, REDIS, RedisThrottlerStorage } from '@uboce/common';
import type { Redis } from 'ioredis';

import { AccountMailer } from './account/account-mailer.js';
import { AccountController } from './account/account.controller.js';
import { AccountService } from './account/account.service.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthService } from './auth/auth.service.js';
import { env, SERVICE_NAME } from './config.js';
import { InternalController } from './internal/internal.controller.js';
import { PrismaModule, PrismaService } from './prisma.service.js';
import { TokensModule } from './tokens/tokens.module.js';

@Module({
  imports: [
    ...coreModules({ serviceName: SERVICE_NAME, env, prismaService: PrismaService, prismaModule: PrismaModule }),
    TokensModule,
    // Brute-force protection on auth endpoints: 10 requests/minute per IP,
    // counted in Redis so the limit holds across instances.
    ThrottlerModule.forRootAsync({
      useFactory: (redis: Redis) => ({
        throttlers: [{ ttl: 60_000, limit: env.AUTH_RATE_LIMIT_PER_MINUTE }],
        storage: new RedisThrottlerStorage(redis),
      }),
      inject: [REDIS],
    }),
  ],
  controllers: [AuthController, AccountController, InternalController],
  providers: [AuthService, AccountService, AccountMailer, OutboxRelayHost(PrismaService)],
})
export class AppModule {}
