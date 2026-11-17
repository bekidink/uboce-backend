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
    /**
     * The scheduler (PRD v2 PLT-02) runs inside this service. It calls each owning
     * service at <SERVICE>_URL (e.g. COMMERCE_URL, KYC_URL); jobs for services
     * without a URL are recorded as skipped. Safe to run on several instances.
     */
    SCHEDULER_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    SCHEDULER_TICK_SECONDS: z.coerce.number().int().min(5).default(15),
    /** Jobs this instance runs at once. */
    SCHEDULER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(4),
    /** Longest a single job call may take before it counts as failed. */
    SCHEDULER_JOB_TIMEOUT_SECONDS: z.coerce.number().int().min(10).max(900).default(300),
    /** Consecutive failures before administrators are emailed. */
    SCHEDULER_ALERT_AFTER_FAILURES: z.coerce.number().int().min(1).default(3),
  }),
);

export const bootstrapEmails = new Set(
  env.ADMIN_BOOTSTRAP_EMAILS.split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);
