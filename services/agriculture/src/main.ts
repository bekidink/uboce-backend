import 'reflect-metadata';

import { bootstrapService } from '@uboce/common';

import { AppModule } from './app.module.js';
import { env } from './config.js';

await bootstrapService(AppModule, {
  port: env.PORT,
  title: 'UBOCE Agriculture Service',
  description: 'Agriculture Service (S11) — farms, seasons, harvests, grading and produce-lot lineage.',
});
