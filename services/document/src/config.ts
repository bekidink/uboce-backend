import { baseEnvSchema, internalCallsEnvSchema, loadEnv } from '@uboce/common';
import { z } from 'zod';

export const SERVICE_NAME = 'document-service';

export const env = loadEnv(
  baseEnvSchema.merge(internalCallsEnvSchema).extend({
    /** Where this service reaches storage. */
    S3_ENDPOINT: z.string().min(1),
    /** Where clients reach storage (signed URLs use it). Defaults to S3_ENDPOINT. */
    S3_PUBLIC_ENDPOINT: z.string().optional(),
    S3_REGION: z.string().default('us-east-1'),
    S3_BUCKET: z.string().default('uboce-documents'),
    S3_ACCESS_KEY: z.string().min(1),
    S3_SECRET_KEY: z.string().min(1),
    MAX_UPLOAD_BYTES: z.coerce.number().int().min(1024).default(10 * 1024 * 1024),
    /** Lifetime of signed upload/download links. */
    LINK_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  }),
);
