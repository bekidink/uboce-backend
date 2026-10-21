import { baseEnvSchema, internalCallsEnvSchema, loadEnv } from '@uboce/common';

export const SERVICE_NAME = 'quality-service';

export const env = loadEnv(baseEnvSchema.merge(internalCallsEnvSchema));
