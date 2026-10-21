import 'reflect-metadata';

import { bootstrapService } from '@uboce/common';

import { AppModule } from './app.module.js';
import { env } from './config.js';

await bootstrapService(AppModule, {
  port: env.PORT,
  title: 'UBOCE Document Service',
  description: 'Document Service (S17) — private file metadata, upload/download grants, retention and audit.',
});
