import { type DynamicModule, Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';

export const REDIS = Symbol('REDIS');

@Injectable()
class RedisShutdown implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown() {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}

/** One shared Redis connection per service, injected with `@Inject(REDIS)`. */
@Global()
@Module({})
export class RedisModule {
  static forRoot(url: string): DynamicModule {
    return {
      module: RedisModule,
      providers: [{ provide: REDIS, useFactory: () => new Redis(url, { maxRetriesPerRequest: 3 }) }, RedisShutdown],
      exports: [REDIS],
    };
  }
}
