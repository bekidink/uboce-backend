import { existsSync } from 'node:fs';
import { z } from 'zod';

let dotEnvLoaded = false;

/**
 * Validates process.env against `schema` and fails fast with every problem
 * listed. Loads `.env` from the working directory first when present, so
 * modules can read config at import time.
 */
export function loadEnv<S extends z.ZodType>(schema: S): z.infer<S> {
  if (!dotEnvLoaded) {
    dotEnvLoaded = true;
    if (existsSync('.env')) process.loadEnvFile('.env');
  }
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}

/** Settings every service needs. Services extend this with their own keys. */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  /** Base64-encoded SPKI PEM of Identity's signing key. */
  JWT_PUBLIC_KEY: z.string().min(1),
  JWT_ISSUER: z.string().default('uboce-identity'),
  JWT_AUDIENCE: z.string().default('uboce'),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;

/** Credentials and peer URLs for services that call other services' internal APIs. */
export const internalCallsEnvSchema = z.object({
  SERVICE_CLIENT_ID: z.string().min(1),
  SERVICE_CLIENT_SECRET: z.string().min(32),
  IDENTITY_URL: z.string().min(1),
  ORGANIZATION_URL: z.string().optional(),
  NOTIFICATION_URL: z.string().optional(),
  ADMINISTRATION_URL: z.string().optional(),
  INVENTORY_URL: z.string().optional(),
  DOCUMENT_URL: z.string().optional(),
  FINANCE_URL: z.string().optional(),
  LOGISTICS_URL: z.string().optional(),
  WAREHOUSE_URL: z.string().optional(),
  COMMERCE_URL: z.string().optional(),
});

export type InternalCallsEnv = z.infer<typeof internalCallsEnvSchema>;

export const internalModuleOptions = (env: InternalCallsEnv) => ({
  clientId: env.SERVICE_CLIENT_ID,
  clientSecret: env.SERVICE_CLIENT_SECRET,
  identityUrl: env.IDENTITY_URL,
  organizationUrl: env.ORGANIZATION_URL,
  notificationUrl: env.NOTIFICATION_URL,
  administrationUrl: env.ADMINISTRATION_URL,
  inventoryUrl: env.INVENTORY_URL,
  documentUrl: env.DOCUMENT_URL,
  financeUrl: env.FINANCE_URL,
  logisticsUrl: env.LOGISTICS_URL,
  warehouseUrl: env.WAREHOUSE_URL,
  commerceUrl: env.COMMERCE_URL,
});

export const decodeBase64 = (value: string) => Buffer.from(value, 'base64').toString('utf8');
