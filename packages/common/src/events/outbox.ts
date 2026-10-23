import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type Type,
} from '@nestjs/common';
import type { EventEnvelope } from '@uboce/contracts';
import type { Redis } from 'ioredis';

import { qualified } from '../database.js';

import { publishToStream } from './envelope.js';
import { REDIS } from './redis.module.js';

/** The slice of a Prisma client the relay needs; works with any service's generated client. */
export interface OutboxDb {
  $transaction<R>(fn: (tx: OutboxTx) => Promise<R>): Promise<R>;
}

export interface OutboxTx {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

export interface OutboxRelayOptions {
  intervalMs?: number;
  batchSize?: number;
}

/**
 * Publishes committed `outbox_events` rows to the event stream.
 *
 * `FOR UPDATE SKIP LOCKED` lets several instances of a service relay in
 * parallel without publishing the same row twice concurrently. If the process
 * dies between publishing and marking a row, the row is published again on the
 * next tick — delivery is at-least-once and consumers dedupe on eventId.
 */
export class OutboxRelay {
  private readonly logger = new Logger('OutboxRelay');
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly db: OutboxDb,
    private readonly redis: Redis,
    private readonly options: OutboxRelayOptions = {},
  ) {}

  start() {
    const interval = this.options.intervalMs ?? 1000;
    this.timer = setInterval(() => {
      this.running ??= this.tick()
        .then(() => undefined)
        .catch((error) => this.logger.error(`Outbox relay tick failed: ${error}`))
        .finally(() => (this.running = null));
    }, interval);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  /** Publishes one batch; returns how many rows were published. */
  async tick(): Promise<number> {
    const batchSize = this.options.batchSize ?? 100;
    return this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ id: string; payload: EventEnvelope }[]>(
        `SELECT id, payload FROM ${qualified('outbox_events')}
         WHERE published_at IS NULL
         ORDER BY created_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        batchSize,
      );

      const published: string[] = [];
      for (const row of rows) {
        try {
          await publishToStream(this.redis, row.payload);
          published.push(row.id);
        } catch (error) {
          // Keep order: stop at the first failure and retry from here next tick.
          await tx.$executeRawUnsafe(
            `UPDATE ${qualified('outbox_events')} SET attempts = attempts + 1, last_error = $2 WHERE id = $1::uuid`,
            row.id,
            String(error).slice(0, 1000),
          );
          break;
        }
      }

      if (published.length > 0) {
        await tx.$executeRawUnsafe(
          `UPDATE ${qualified('outbox_events')} SET published_at = now() WHERE id = ANY($1::uuid[])`,
          published,
        );
      }
      return published.length;
    });
  }
}

/** Provider that runs an OutboxRelay for the app's lifetime: `providers: [OutboxRelayHost(PrismaService)]`. */
export function OutboxRelayHost(dbToken: unknown, options?: OutboxRelayOptions): Type<unknown> {
  @Injectable()
  class OutboxRelayHostImpl implements OnApplicationBootstrap, BeforeApplicationShutdown {
    private readonly relay: OutboxRelay;

    constructor(@Inject(dbToken as never) db: OutboxDb, @Inject(REDIS) redis: Redis) {
      this.relay = new OutboxRelay(db, redis, options);
    }

    onApplicationBootstrap() {
      this.relay.start();
    }

    async beforeApplicationShutdown() {
      await this.relay.stop();
    }
  }
  return OutboxRelayHostImpl;
}
