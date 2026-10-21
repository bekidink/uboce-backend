import 'reflect-metadata';

import { bootstrapService } from '@uboce/common';

import { AppModule } from './app.module.js';
import { env } from './config.js';

await bootstrapService(AppModule, {
  port: env.PORT,
  title: 'UBOCE Finance Service',
  description: 'Finance Operations Service (S15) — invoices, external payment references and reconciliation.',
});
