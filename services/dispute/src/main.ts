import 'reflect-metadata';

import { bootstrapService } from '@uboce/common';

import { AppModule } from './app.module.js';
import { env } from './config.js';

await bootstrapService(AppModule, {
  port: env.PORT,
  title: 'UBOCE Dispute Service',
  description: 'Dispute & Performance Service (S18) — disputes, evidence, resolutions and supplier metrics.',
});
