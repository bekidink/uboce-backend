import { baseEnvSchema, internalCallsEnvSchema, loadEnv } from '@uboce/common';
import { z } from 'zod';

export const SERVICE_NAME = 'inventory-service';

export const env = loadEnv(
  baseEnvSchema.merge(internalCallsEnvSchema).extend({
    /** Order reservations untouched this long are checked against the order (PRD v2 INV-02). */
    RESERVATION_CHECK_DAYS: z.coerce.number().int().positive().default(14),
    /** Sellers hear about batches expiring within this many days (INV-04). */
    STOCK_EXPIRY_ALERT_DAYS: z.coerce.number().int().positive().default(14),
  }),
);
