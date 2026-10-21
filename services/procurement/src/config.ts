import { baseEnvSchema, internalCallsEnvSchema, loadEnv } from '@uboce/common';
import { z } from 'zod';

export const SERVICE_NAME = 'procurement-service';

export const env = loadEnv(
  baseEnvSchema.merge(internalCallsEnvSchema).extend({
    /**
     * Pilot policy (PRD 14 sequencing note): when true, only KYB-verified
     * organizations can submit quotations. Off until the KYB service exists.
     */
    REQUIRE_VERIFIED_SUPPLIERS: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
  }),
);
