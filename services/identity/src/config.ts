import { baseEnvSchema, internalCallsEnvSchema, loadEnv } from '@uboce/common';
import { z } from 'zod';

export const SERVICE_NAME = 'identity-service';

export const env = loadEnv(
  baseEnvSchema.merge(internalCallsEnvSchema).extend({
    /** Base64-encoded PKCS#8 PEM. Only Identity ever holds this key. */
    JWT_PRIVATE_KEY: z.string().min(1),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).default(30),
    SERVICE_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(300),
    /**
     * Services allowed to get service tokens: `name:sha256(secret)` pairs,
     * comma-separated. `pnpm setup` generates them.
     */
    SERVICE_CLIENTS: z.string().min(1),
    /** 32 random bytes, base64. Encrypts TOTP secrets at rest. */
    MFA_ENCRYPTION_KEY: z.string().min(40),
    /** Per IP, on each auth endpoint. Raise only for load tests. */
    AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(10),
    /** Web/mobile app base URL used in emailed links. */
    APP_BASE_URL: z.string().default('http://localhost:4200'),
  }),
);

/** Registered service clients: name → SHA-256 of their secret. */
export const serviceClients = new Map(
  env.SERVICE_CLIENTS.split(',')
    .map((pair) => pair.trim().split(':') as [string, string])
    .filter(([name, hash]) => name && hash),
);
