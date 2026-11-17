import { baseEnvSchema, internalCallsEnvSchema, loadEnv } from '@uboce/common';
import { z } from 'zod';

export const SERVICE_NAME = 'commerce-service';

export const env = loadEnv(
  baseEnvSchema.merge(internalCallsEnvSchema).extend({
    /** Unconfirmed orders are cancelled after this long (PRD v2 ORD-07). */
    ORDER_CONFIRM_HOURS: z.coerce.number().positive().default(72),
    /** Pickup hold when the order has no policy snapshot (ORD-15). */
    PICKUP_HOLD_HOURS: z.coerce.number().positive().default(72),
    /** Delivered orders without a return window close after this long. */
    ORDER_CLOSE_GRACE_HOURS: z.coerce.number().nonnegative().default(72),
  }),
);
