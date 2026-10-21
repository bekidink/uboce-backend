import { hostname } from 'node:os';

import { Logger } from '@nestjs/common';
import { DEAD_LETTER_STREAM, EVENT_STREAM, type EventEnvelope } from '@uboce/contracts';
import type { Redis } from 'ioredis';

import { runWithCorrelationId } from '../context.js';
import { publishToStream } from './envelope.js';

export type EventHandler = (event: EventEnvelope) => Promise<void>;

export interface StreamConsumerOptions {
  /** Consumer group, normally the service name. Each group sees every event once. */
  group: string;
  handlers: Record<string, EventHandler>;
  /** Deliveries before an event is parked on the dead-letter stream. */
  maxDeliveries?: number;
  /** How long an unacknowledged event waits before another consumer retries it. */
  retryAfterMs?: number;
  stream?: string;
}

type StreamEntry = [id: string, fields: string[]];

/**
 * Reads the event stream with a Redis consumer group. Handlers must be
 * idempotent (delivery is at-least-once); failures are retried after
 * `retryAfterMs` and dead-lettered after `maxDeliveries`.
 */
export class StreamConsumer {
  private readonly logger = new Logger('StreamConsumer');
  private readonly consumer = `${hostname()}-${process.pid}`;
  private readonly stream: string;
  private connection: Redis | null = null;
  private loop: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly redis: Redis,
    private readonly options: StreamConsumerOptions,
  ) {
    this.stream = options.stream ?? EVENT_STREAM;
  }

  async start() {
    try {
      await this.redis.xgroup('CREATE', this.stream, this.options.group, '$', 'MKSTREAM');
    } catch (error) {
      if (!String(error).includes('BUSYGROUP')) throw error;
    }
    // Blocking reads need their own connection so they don't stall other commands.
    this.connection = this.redis.duplicate();
    this.loop = this.run();
  }

  async stop() {
    this.stopped = true;
    this.connection?.disconnect();
    await this.loop?.catch(() => {});
  }

  private async run() {
    while (!this.stopped) {
      try {
        await this.retryStale();
        const result = (await this.connection!.xreadgroup(
          'GROUP',
          this.options.group,
          this.consumer,
          'COUNT',
          50,
          'BLOCK',
          5000,
          'STREAMS',
          this.stream,
          '>',
        )) as [string, StreamEntry[]][] | null;
        for (const [, entries] of result ?? []) {
          for (const entry of entries) await this.process(entry);
        }
      } catch (error) {
        if (this.stopped) return;
        this.logger.error(`Event loop error: ${error}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  /** Claims events another consumer (or this one) failed to acknowledge in time. */
  private async retryStale() {
    const [, entries] = (await this.redis.xautoclaim(
      this.stream,
      this.options.group,
      this.consumer,
      this.options.retryAfterMs ?? 30_000,
      '0-0',
      'COUNT',
      50,
    )) as [string, StreamEntry[]];
    for (const entry of entries) await this.process(entry);
  }

  private async process([id, fields]: StreamEntry) {
    const envelopeJson = fieldValue(fields, 'envelope');
    let event: EventEnvelope;
    try {
      event = JSON.parse(envelopeJson ?? '');
    } catch {
      this.logger.error(`Dropping malformed stream entry ${id}`);
      await this.redis.xack(this.stream, this.options.group, id);
      return;
    }

    const handler = this.options.handlers[event.eventType];
    if (!handler) {
      await this.redis.xack(this.stream, this.options.group, id);
      return;
    }

    try {
      await runWithCorrelationId(event.correlationId ?? event.eventId, () => handler(event));
      await this.redis.xack(this.stream, this.options.group, id);
    } catch (error) {
      const deliveries = await this.deliveryCount(id);
      this.logger.warn(`Handler for ${event.eventType} ${event.eventId} failed (delivery ${deliveries}): ${error}`);
      if (deliveries >= (this.options.maxDeliveries ?? 5)) {
        await publishToStream(this.redis, event, DEAD_LETTER_STREAM);
        await this.redis.xack(this.stream, this.options.group, id);
        this.logger.error(`Dead-lettered ${event.eventType} ${event.eventId}`);
      }
    }
  }

  private async deliveryCount(id: string): Promise<number> {
    const pending = (await this.redis.xpending(this.stream, this.options.group, id, id, 1)) as [
      string,
      string,
      number,
      number,
    ][];
    return pending[0]?.[3] ?? 1;
  }
}

const fieldValue = (fields: string[], key: string) => {
  const index = fields.indexOf(key);
  return index >= 0 && index % 2 === 0 ? fields[index + 1] : undefined;
};
