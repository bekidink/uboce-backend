import { baseEnvSchema, loadEnv } from '@uboce/common';

export const SERVICE_NAME = 'discovery-service';

export const env = loadEnv(baseEnvSchema);
