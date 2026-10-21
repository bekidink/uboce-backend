import { randomUUID } from 'node:crypto';

import {
  type DomainEvent,
  EVENT_SCHEMA_VERSIONS,
  EVENT_STREAM,
  type EventCatalog,
  type EventEnvelope,
  type EventType,
} from '@uboce/contracts';
import type { Redis } from 'ioredis';

import { currentCorrelationId } from '../context.js';

export function buildEvent<T extends EventType>(
  producer: string,
  eventType: T,
  aggregateId: string,
  data: EventCatalog[T],
): DomainEvent<T> {
  return {
    eventId: randomUUID(),
    eventType,
    schemaVersion: EVENT_SCHEMA_VERSIONS[eventType],
    occurredAt: new Date().toISOString(),
    producer,
    aggregateId,
    correlationId: currentCorrelationId(),
    data,
  };
}

/**
 * The row a service inserts into its own `outbox_events` table, in the same
 * transaction as the state change it describes (PRD 8.3).
 */
export const toOutboxRow = (event: EventEnvelope) => ({
  id: event.eventId,
  eventType: event.eventType,
  payload: event as unknown as object,
});

// Stream entries are capped; consumers that fall this far behind need a replay
// from the producers' outbox tables, which keep every event.
const STREAM_MAX_LENGTH = '1000000';

export async function publishToStream(redis: Redis, event: EventEnvelope, stream = EVENT_STREAM) {
  await redis.xadd(
    stream,
    'MAXLEN',
    '~',
    STREAM_MAX_LENGTH,
    '*',
    'eventId',
    event.eventId,
    'eventType',
    event.eventType,
    'envelope',
    JSON.stringify(event),
  );
}
