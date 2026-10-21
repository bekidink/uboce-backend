import type { EventEnvelope } from '@uboce/contracts';

import type { OutboxTx } from './outbox.js';

export interface InboxDb<Tx extends OutboxTx> {
  $transaction<R>(fn: (tx: Tx) => Promise<R>): Promise<R>;
}

/**
 * Runs `work` once per event per service (PRD 8.3: idempotent consumers).
 * The service's `processed_events` row and its own changes commit together,
 * so a redelivered or concurrently-delivered event is a no-op.
 * Returns false when the event had already been handled.
 */
export async function handleOnce<Tx extends OutboxTx>(
  db: InboxDb<Tx>,
  event: EventEnvelope,
  work: (tx: Tx) => Promise<void>,
): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const inserted = await tx.$executeRawUnsafe(
      `INSERT INTO processed_events (event_id, event_type) VALUES ($1::uuid, $2) ON CONFLICT (event_id) DO NOTHING`,
      event.eventId,
      event.eventType,
    );
    if (inserted === 0) return false;
    await work(tx);
    return true;
  });
}
