import { existsSync } from 'node:fs';

import { z } from 'zod';

import type { ServiceName } from './routes.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4100),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  REDIS_URL: z.string().min(1),
  /** Comma-separated browser origins allowed to call the API, e.g. https://app.uboce.et */
  CORS_ORIGINS: z.string().default(''),
  /** Per client IP per minute, across all gateway instances. */
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(300),
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(30),
  /** Hops in front of the gateway (load balancer) whose X-Forwarded-For is trusted. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  IDENTITY_URL: z.string().min(1),
  ORGANIZATION_URL: z.string().min(1),
  NOTIFICATION_URL: z.string().min(1),
  CATALOG_URL: z.string().min(1),
  DISCOVERY_URL: z.string().min(1),
  PROCUREMENT_URL: z.string().min(1),
  COMMERCE_URL: z.string().min(1),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid gateway configuration:\n${parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`);
}
export const env = parsed.data;

export const upstreams: Record<ServiceName, string> = {
  identity: env.IDENTITY_URL,
  organization: env.ORGANIZATION_URL,
  notification: env.NOTIFICATION_URL,
  catalog: env.CATALOG_URL,
  discovery: env.DISCOVERY_URL,
  procurement: env.PROCUREMENT_URL,
  commerce: env.COMMERCE_URL,
};

export const corsOrigins = new Set(env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean));
