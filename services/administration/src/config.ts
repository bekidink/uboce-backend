import { baseEnvSchema, internalCallsEnvSchema, loadEnv } from '@uboce/common';
import { z } from 'zod';

export const SERVICE_NAME = 'administration-service';

export const env = loadEnv(
  baseEnvSchema.merge(internalCallsEnvSchema).extend({
    /**
     * Emails that become platform_admin on first use, once their address is
     * verified — how the very first administrator is created. Comma-separated.
     */
    ADMIN_BOOTSTRAP_EMAILS: z.string().default(''),
    /** Staff roles only take effect for accounts with two-factor sign-in (PRD 5.1). */
    REQUIRE_STAFF_MFA: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
  }),
);

export const bootstrapEmails = new Set(
  env.ADMIN_BOOTSTRAP_EMAILS.split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);
