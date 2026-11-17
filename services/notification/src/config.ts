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
    /**
     * SMS gateway (PRD v2 NTF-02): log (default; nothing is sent), afromessage, or http.
     * afromessage needs SMS_API_TOKEN (and usually SMS_IDENTIFIER_ID, SMS_SENDER);
     * http needs SMS_HTTP_URL and accepts { to, message, sender, callbackUrl }.
     */
    SMS_PROVIDER: z.enum(['log', 'afromessage', 'http']).default('log'),
    SMS_API_TOKEN: z.string().optional(),
    SMS_API_URL: z.string().default('https://api.afromessage.com/api'),
    SMS_IDENTIFIER_ID: z.string().optional(),
    /** Registered sender name shown on the handset. */
    SMS_SENDER: z.string().optional(),
    SMS_HTTP_URL: z.string().optional(),
    /** Shared secret in the delivery-receipt URL: <PUBLIC_API_URL>/api/v1/notifications/sms/receipts/<provider>?token=… */
    SMS_CALLBACK_TOKEN: z.string().min(24).optional(),
    PUBLIC_API_URL: z.string().default('http://localhost:4100'),
    SMS_MAX_PER_NUMBER_PER_HOUR: z.coerce.number().int().min(1).default(10),
    /** Estimated cost per SMS part, in ETB; 0 = don't track. */
    SMS_COST_PER_SEGMENT: z.coerce.number().min(0).default(0.35),
    /** Monthly cap on estimated SMS spend; sign-in codes are always sent. 0 = no cap. */
    SMS_MONTHLY_BUDGET: z.coerce.number().min(0).default(0),
  }),
);
