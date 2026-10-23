import { randomUUID } from 'node:crypto';

import { CORRELATION_HEADER, hitRateLimit } from '@uboce/common';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { Redis } from 'ioredis';
import { pino } from 'pino';
import { pinoHttp } from 'pino-http';

import { corsOrigins, env, upstreams } from './config.js';
import { docsRouter } from './docs.js';
import { resolveService, type ServiceName } from './routes.js';

const logger = pino({ level: env.LOG_LEVEL, base: { service: 'api-gateway' } });
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
const app = express();

app.disable('x-powered-by');
app.set('trust proxy', env.TRUST_PROXY_HOPS);

const errorBody = (req: Request, code: string, message: string) => ({
  error: { code, message },
  correlationId: req.headers[CORRELATION_HEADER] ?? null,
});

// Correlation ID first, so every log line and upstream request carries it.
app.use((req, res, next) => {
  const incoming = req.headers[CORRELATION_HEADER];
  const id = typeof incoming === 'string' && /^[\w-]{8,128}$/.test(incoming) ? incoming : randomUUID();
  req.headers[CORRELATION_HEADER] = id;
  res.setHeader(CORRELATION_HEADER, id);
  next();
});

app.use(
  pinoHttp({
    logger,
    genReqId: (req) => String(req.headers[CORRELATION_HEADER]),
    customProps: (req) => ({ correlationId: req.id }),
    redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'], censor: '[redacted]' },
    autoLogging: { ignore: (req) => req.url?.startsWith('/health') ?? false },
  }),
);

app.use(helmet());

// CORS: explicit allowlist only. Native mobile apps don't send Origin and are unaffected.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && corsOrigins.has(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
    res.setHeader('access-control-allow-headers', 'authorization, content-type, idempotency-key, x-organization-id, x-correlation-id');
    res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    res.setHeader('access-control-expose-headers', 'x-correlation-id, retry-after, idempotent-replayed');
    res.setHeader('access-control-max-age', '600');
  }
  if (req.method === 'OPTIONS') {
    res.status(origin && corsOrigins.has(origin) ? 204 : 403).end();
    return;
  }
  next();
});

// ---- Health ---------------------------------------------------------------------

app.get('/health/live', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/health/ready', async (_req, res) => {
  const checks = await Promise.all(
    Object.entries(upstreams).map(async ([name, url]) => {
      try {
        const r = await fetch(`${url}/health/ready`, { signal: AbortSignal.timeout(2000) });
        return [name, r.ok ? 'ok' : 'down'] as const;
      } catch {
        return [name, 'down'] as const;
      }
    }),
  );
  const redisOk = await redis.ping().then(() => true, () => false);
  const all = { ...Object.fromEntries(checks), redis: redisOk ? 'ok' : 'down' };
  const ok = Object.values(all).every((s) => s === 'ok');
  res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'down', checks: all });
});

// ---- API docs: one Swagger UI for every service (disable with DOCS_ENABLED=false) ----

if (env.DOCS_ENABLED) app.use(docsRouter(upstreams, logger));

// ---- Routing, rate limiting, proxying --------------------------------------------

/** Rejects unknown and internal paths before they reach any service. */
const route = (req: Request, res: Response, next: NextFunction) => {
  const service = resolveService(req.originalUrl);
  if (!service) {
    res.status(404).json(errorBody(req, 'not_found', 'Not found'));
    return;
  }
  res.locals.service = service;
  next();
};

/**
 * Fixed one-minute windows per client IP, counted in Redis so the limit holds
 * across gateway instances. Auth routes get a much tighter budget. If Redis is
 * down the request is let through: an outage shouldn't take the API down.
 */
const rateLimit = async (req: Request, res: Response, next: NextFunction) => {
  const auth = res.locals.service === 'identity';
  const limit = auth ? env.AUTH_RATE_LIMIT_PER_MINUTE : env.RATE_LIMIT_PER_MINUTE;
  try {
    const result = await hitRateLimit(redis, `gw:${auth ? 'auth' : 'api'}:${req.ip}`, 60_000, limit);
    res.setHeader('ratelimit-limit', limit);
    res.setHeader('ratelimit-remaining', Math.max(limit - result.hits, 0));
    if (result.limited) {
      res.setHeader('retry-after', Math.ceil(result.retryAfterMs / 1000));
      res.status(429).json(errorBody(req, 'rate_limited', 'Too many requests; try again shortly'));
      return;
    }
  } catch (error) {
    req.log.warn({ err: error }, 'rate limiter unavailable; allowing request');
  }
  next();
};

const proxies = Object.fromEntries(
  Object.entries(upstreams).map(([name, target]) => [
    name,
    createProxyMiddleware<Request, Response>({
      target,
      changeOrigin: true,
      xfwd: true,
      proxyTimeout: 30_000,
      timeout: 30_000,
      on: {
        error: (err, req, res) => {
          logger.error({ err, service: name, correlationId: req.headers[CORRELATION_HEADER] }, 'upstream error');
          const response = res as Response;
          if (!response.headersSent) {
            response.status(502).json(errorBody(req as Request, 'upstream_unavailable', 'The service is temporarily unavailable'));
          }
        },
      },
    }),
  ]),
) as Record<ServiceName, ReturnType<typeof createProxyMiddleware>>;

app.use(route, rateLimit, (req: Request, res: Response, next: NextFunction) => {
  // Mounted at the root, so Express passes the full original path through unchanged.
  proxies[res.locals.service as ServiceName](req, res, next);
});

const server = app.listen(env.PORT, () => logger.info(`API gateway listening on ${env.PORT}`));
// Request bodies stream straight through to services, which enforce their own size limits.
server.headersTimeout = 30_000;
server.requestTimeout = 60_000;

const shutdown = () => {
  logger.info('shutting down');
  server.close(() => {
    redis.disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
