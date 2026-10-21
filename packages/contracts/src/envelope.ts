/** PRD 8.4 event envelope. Delivery is at-least-once: consumers must dedupe on `eventId`. */
export interface EventEnvelope<TType extends string = string, TData = unknown> {
  eventId: string;
  eventType: TType;
  schemaVersion: number;
  occurredAt: string;
  producer: string;
  aggregateId: string;
  correlationId: string | null;
  data: TData;
}

/** The single stream all producers publish to; consumers read it with their own consumer group. */
export const EVENT_STREAM = 'uboce.events';
export const DEAD_LETTER_STREAM = 'uboce.events.dlq';
