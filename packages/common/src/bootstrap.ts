import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';

import { correlationMiddleware } from './context.js';
import { AllExceptionsFilter } from './errors.js';

export const API_PREFIX = 'api/v1';

export interface BootstrapOptions {
  port: number;
  title: string;
  description: string;
}

/**
 * Shared HTTP setup so every service behaves the same: versioned prefix,
 * correlation IDs, validation, one error shape, OpenAPI at /docs, graceful shutdown.
 */
export async function bootstrapService(appModule: unknown, options: BootstrapOptions) {
  // rawBody: signed webhooks are verified against the exact bytes received.
  const app = await NestFactory.create(appModule as never, { bufferLogs: true, rawBody: true });
  app.useLogger(app.get(Logger));
  // Services sit behind the gateway on a private network; trust X-Forwarded-For
  // only from private/loopback hops so req.ip (used for rate limits and audit) is the real client.
  app.getHttpAdapter().getInstance().set('trust proxy', 'loopback, linklocal, uniquelocal');
  app.use(correlationMiddleware);
  app.use(helmet());
  app.setGlobalPrefix(API_PREFIX, {
    exclude: [
      { path: 'health/live', method: RequestMethod.GET },
      { path: 'health/ready', method: RequestMethod.GET },
    ],
  });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle(options.title)
      .setDescription(options.description)
      .setVersion('1')
      .addBearerAuth()
      .build(),
  );
  SwaggerModule.setup('docs', app, document);

  await app.listen(options.port);
  return app;
}
