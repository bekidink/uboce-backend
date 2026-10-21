import 'reflect-metadata';

import { bootstrapService } from '@uboce/common';

import { AppModule } from './app.module.js';
import { env } from './config.js';

await bootstrapService(AppModule, {
  port: env.PORT,
  title: 'UBOCE Integration Service',
  description: 'Integration Service (S19) — provider adapters, verified callbacks and normalized results.',
});
