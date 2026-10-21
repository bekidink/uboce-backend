import { type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import type { DomainEvent, EventEnvelope, EventType } from '@uboce/contracts';
import type { Redis } from 'ioredis';

import { type EventHandler, StreamConsumer } from './consumer.js';
import { handleOnce, type InboxDb } from './inbox.js';
import type { OutboxTx } from './outbox.js';

/**
 * Base for a service's event subscriptions. Subclasses list handlers; each runs
 * once per event (inbox) inside a transaction with the service's own changes.
 *
 *   @Injectable() class Handlers extends EventConsumer<Tx> {
 *     constructor(@Inject(REDIS) redis: Redis, prisma: PrismaService) { super(redis, prisma, 'inventory-service'); }
 *     protected subscriptions() { return { OrderConfirmed: this.once('OrderConfirmed', (e, tx) => …) }; }
 *   }
 */
export abstract class EventConsumer<Tx extends OutboxTx> implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private consumer: StreamConsumer | null = null;

  protected constructor(
    private readonly redis: Redis,
    protected readonly db: InboxDb<Tx>,
    private readonly group: string,
  ) {}

  protected abstract subscriptions(): Record<string, EventHandler>;

  /** Wraps a handler so it runs at most once per event, in one transaction with the inbox row. */
  protected once<T extends EventType>(_type: T, apply: (event: DomainEvent<T>, tx: Tx) => Promise<void>): EventHandler {
    return async (event: EventEnvelope) => {
      await handleOnce<Tx>(this.db, event, (tx) => apply(event as DomainEvent<T>, tx));
    };
  }

  /** For handlers that are idempotent on their own (e.g. keyed by an order ID) and manage their own transactions. */
  protected on<T extends EventType>(_type: T, apply: (event: DomainEvent<T>) => Promise<void>): EventHandler {
    return (event: EventEnvelope) => apply(event as DomainEvent<T>);
  }

  async onApplicationBootstrap() {
    this.consumer = new StreamConsumer(this.redis, { group: this.group, handlers: this.subscriptions() });
    await this.consumer.start();
  }

  async beforeApplicationShutdown() {
    await this.consumer?.stop();
  }
}
