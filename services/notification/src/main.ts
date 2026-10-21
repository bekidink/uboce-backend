import 'reflect-metadata';

import { bootstrapService } from '@uboce/common';

import { AppModule } from './app.module.js';
import { env } from './config.js';

await bootstrapService(AppModule, {
  port: env.PORT,
  title: 'UBOCE Notification Service',
  description: 'Device tokens, in-app notifications and push via Firebase Cloud Messaging (PRD S16).',
});
