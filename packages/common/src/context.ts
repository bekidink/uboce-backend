import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const CORRELATION_HEADER = 'x-correlation-id';

interface RequestContext {
  correlationId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** The correlation ID of the HTTP request or event being handled, if any. */
export const currentCorrelationId = (): string | null => storage.getStore()?.correlationId ?? null;

/** Runs `fn` with a correlation ID, e.g. while handling a consumed event. */
export const runWithCorrelationId = <T>(correlationId: string, fn: () => T): T =>
  storage.run({ correlationId }, fn);

const VALID_ID = /^[\w-]{8,128}$/;

/**
 * Accepts a caller's correlation ID (or mints one), echoes it back, and makes it
 * available to logs and outgoing events for the rest of the request.
 */
export function correlationMiddleware(req: Request, res: Response, next: NextFunction) {
  const incoming = req.headers[CORRELATION_HEADER];
  const correlationId = typeof incoming === 'string' && VALID_ID.test(incoming) ? incoming : randomUUID();
  req.headers[CORRELATION_HEADER] = correlationId;
  res.setHeader(CORRELATION_HEADER, correlationId);
  storage.run({ correlationId }, next);
}
