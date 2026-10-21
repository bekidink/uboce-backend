import 'reflect-metadata';

import { bootstrapService } from '@uboce/common';

import { AppModule } from './app.module.js';
import { env } from './config.js';

await bootstrapService(AppModule, {
  port: env.PORT,
  title: 'UBOCE Procurement Service',
  description: 'RFQs, quotations, revisions, comparison and supplier selection (PRD S07).',
});
