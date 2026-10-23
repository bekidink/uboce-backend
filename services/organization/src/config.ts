import { baseEnvSchema, internalCallsEnvSchema, loadEnv } from '@uboce/common';
import { z } from 'zod';

export const SERVICE_NAME = 'organization-service';

export const env = loadEnv(
  baseEnvSchema.merge(internalCallsEnvSchema).extend({
    /** Web/mobile app base URL used in invitation links. */
    APP_BASE_URL: z.string().default('http://localhost:4200'),
    INVITATION_TTL_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  }),
);
