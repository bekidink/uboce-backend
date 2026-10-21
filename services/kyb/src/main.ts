import 'reflect-metadata';

import { bootstrapService } from '@uboce/common';

import { AppModule } from './app.module.js';
import { env } from './config.js';

await bootstrapService(AppModule, {
  port: env.PORT,
  title: 'UBOCE Kyb Service',
  description: 'KYB / Trust Service (S04) — business verification cases, review and decisions.',
});
