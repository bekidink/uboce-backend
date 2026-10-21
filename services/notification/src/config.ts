import { baseEnvSchema, internalCallsEnvSchema, loadEnv } from '@uboce/common';
import { z } from 'zod';

export const SERVICE_NAME = 'notification-service';

export const env = loadEnv(
  baseEnvSchema.merge(internalCallsEnvSchema).extend({
    /**
     * Path to a Firebase service-account JSON with the Cloud Messaging permission.
     * When unset, push messages are logged instead of sent.
     */
    FIREBASE_SERVICE_ACCOUNT_PATH: z.string().optional(),
    /** e.g. smtp://localhost:1025 (Mailpit) or smtps://user:pass@smtp.provider.com:465. Unset = log only. */
    SMTP_URL: z.string().optional(),
    EMAIL_FROM: z.string().default('UBOCE <no-reply@uboce.local>'),
  }),
);
