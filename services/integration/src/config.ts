import { baseEnvSchema, internalCallsEnvSchema, loadEnv } from '@uboce/common';
import { z } from 'zod';

export const SERVICE_NAME = 'integration-service';

export const env = loadEnv(
  baseEnvSchema.merge(internalCallsEnvSchema).extend({
    /**
     * Webhook providers as `name:kind:secret` triples, comma-separated, where
     * kind is `payment`, `carrier`, `chapa` (Chapa's own webhook format) or `stripe` (Stripe events;
     * the secret is the endpoint's signing secret, whsec_…). Secrets are shared with each provider.
     */
    PROVIDERS: z.string().default(''),
    /** How old a signed callback may be before it's refused as a replay. */
    /**
     * Optional, read-only use: looks up Stripe's real fee and resolves lost chargebacks to an
     * invoice. A restricted key with PaymentIntents read access is enough.
     */
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_API_URL: z.string().default('https://api.stripe.com/v1'),
    CALLBACK_MAX_AGE_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  }),
);

export interface ProviderConfig {
  name: string;
  kind: 'payment' | 'carrier' | 'chapa' | 'stripe';
  secret: string;
}

export const providers = new Map<string, ProviderConfig>(
  env.PROVIDERS.split(',')
    .map((triple) => triple.trim().split(':'))
    .filter((parts): parts is [string, string, string] => parts.length === 3 && ['payment', 'carrier', 'chapa', 'stripe'].includes(parts[1]!) && parts[2]!.length >= 16)
    .map(([name, kind, secret]) => [name, { name, kind: kind as ProviderConfig['kind'], secret }]),
);
