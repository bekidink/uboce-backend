import { baseEnvSchema, internalCallsEnvSchema, loadEnv } from '@uboce/common';
import { z } from 'zod';

export const SERVICE_NAME = 'integration-service';

export const env = loadEnv(
  baseEnvSchema.merge(internalCallsEnvSchema).extend({
    /**
     * Webhook providers as `name:kind:secret` triples, comma-separated, where
     * kind is `payment` or `carrier`. Secrets are shared with each provider.
     */
    PROVIDERS: z.string().default(''),
    /** How old a signed callback may be before it's refused as a replay. */
    CALLBACK_MAX_AGE_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  }),
);

export interface ProviderConfig {
  name: string;
  kind: 'payment' | 'carrier';
  secret: string;
}

export const providers = new Map<string, ProviderConfig>(
  env.PROVIDERS.split(',')
    .map((triple) => triple.trim().split(':'))
    .filter((parts): parts is [string, string, string] => parts.length === 3 && (parts[1] === 'payment' || parts[1] === 'carrier') && parts[2]!.length >= 16)
    .map(([name, kind, secret]) => [name, { name, kind: kind as ProviderConfig['kind'], secret }]),
);
