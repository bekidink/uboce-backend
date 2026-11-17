import { baseEnvSchema, internalCallsEnvSchema, loadEnv } from '@uboce/common';
import { z } from 'zod';

export const SERVICE_NAME = 'finance-service';

export const env = loadEnv(
  baseEnvSchema.merge(internalCallsEnvSchema).extend({
    /** Where buyers return after paying (the web app). */
    APP_BASE_URL: z.string().default('http://localhost:4200'),
    /** Public gateway URL, for provider callbacks (…/api/v1/integrations/callbacks/<provider>). */
    PUBLIC_API_URL: z.string().default('http://localhost:4100'),
    /**
     * Enabled payment providers, comma-separated: manual, sandbox, chapa, stripe, telebirr.
     * Chapa needs CHAPA_SECRET_KEY, Stripe needs STRIPE_SECRET_KEY; telebirr is not supported yet.
     */
    PAYMENT_PROVIDERS: z.string().default('manual,sandbox'),
    CHAPA_SECRET_KEY: z.string().optional(),
    CHAPA_API_URL: z.string().default('https://api.chapa.co/v1'),
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_API_URL: z.string().default('https://api.stripe.com/v1'),
    /** Fee percentages per provider when the provider doesn't report one, e.g. "chapa:3.5,stripe:2.9,sandbox:1.5". */
    PAYMENT_FEES_PCT: z.string().default('sandbox:1.5,chapa:3.5,stripe:2.9'),
    /** Unfinished checkout attempts expire after this long (PRD v2 FIN-05). */
    PAYMENT_ATTEMPT_TTL_MINUTES: z.coerce.number().int().positive().default(60),
    /** Days between overdue reminders, and how many to send (PLT-03). */
    INVOICE_REMINDER_DAYS: z.coerce.number().int().positive().default(7),
    INVOICE_MAX_REMINDERS: z.coerce.number().int().min(1).default(3),
  }),
);
