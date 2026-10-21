import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';

// Fixed window counter + optional block, in one atomic round trip.
// KEYS: counter, block flag. ARGV: window ms, limit, block ms.
const SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if hits > tonumber(ARGV[2]) and tonumber(ARGV[3]) > 0 and redis.call('EXISTS', KEYS[2]) == 0 then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
end
local blockTtl = redis.call('PTTL', KEYS[2])
return { hits, ttl, blockTtl }
`;

export interface RateLimitResult {
  hits: number;
  limited: boolean;
  /** Milliseconds until the caller may try again. */
  retryAfterMs: number;
}

/** Shared across every instance of every service, unlike in-memory limits. */
export async function hitRateLimit(redis: Redis, key: string, windowMs: number, limit: number, blockMs = 0) {
  const [hits, ttl, blockTtl] = (await redis.eval(
    SCRIPT,
    2,
    `uboce:rl:${key}`,
    `uboce:rl:block:${key}`,
    windowMs,
    limit,
    blockMs,
  )) as [number, number, number];
  const blocked = blockTtl > 0;
  return {
    hits,
    limited: blocked || hits > limit,
    retryAfterMs: Math.max(blocked ? blockTtl : ttl, 0),
  } satisfies RateLimitResult;
}

/** @nestjs/throttler storage backed by Redis. */
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly redis: Redis) {}

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string) {
    const result = await hitRateLimit(this.redis, `${throttlerName}:${key}`, ttl, limit, blockDuration);
    const seconds = Math.ceil(result.retryAfterMs / 1000);
    return {
      totalHits: result.hits,
      timeToExpire: seconds,
      isBlocked: result.limited,
      timeToBlockExpire: result.limited ? seconds : 0,
    };
  }
}
