import 'reflect-metadata';

import { bootstrapService } from '@uboce/common';

import { AppModule } from './app.module.js';
import { env } from './config.js';

await bootstrapService(AppModule, {
  port: env.PORT,
  title: 'UBOCE Administration Service',
  description: 'Administration Service (S21) — platform staff roles, settings, feature flags and audited admin actions.',
});
