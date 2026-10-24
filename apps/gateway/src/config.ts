import { existsSync } from 'node:fs';

import { serviceUrl } from '@uboce/common';
import { z } from 'zod';

import { type ServiceName, SERVICES } from './routes.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const urlVar = (service: string) => `${service.toUpperCase()}_URL`;

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
  /** Serve the combined Swagger UI at /docs. Turn off where the API surface should not be browsable. */
  DOCS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** Serve a built web app (index.html + assets) from this directory for every non-API path. */
  WEB_ROOT: z.string().optional(),
  /** Extra origins the web app may connect to (e.g. the S3 host it uploads to), space-separated. */
  WEB_CONNECT_SRC: z.string().default(''),
  /** Origins allowed to embed the app in a frame (e.g. https://huggingface.co), space-separated. */
  FRAME_ANCESTORS: z.string().default(''),
  // One <SERVICE>_URL per upstream, e.g. IDENTITY_URL.
  ...Object.fromEntries(SERVICES.map((s) => [urlVar(s), z.string().min(1)])),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid gateway configuration:\n${parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`);
}
export const env = parsed.data as z.infer<typeof schema> & Record<string, string>;

export const upstreams = Object.fromEntries(SERVICES.map((s) => [s, serviceUrl(env[urlVar(s)]!)])) as Record<ServiceName, string>;

export const corsOrigins = new Set(env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean));
