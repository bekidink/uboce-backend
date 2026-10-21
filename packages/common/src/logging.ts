import { LoggerModule } from 'nestjs-pino';

import { CORRELATION_HEADER } from './context.js';

/** Structured JSON logs with service name and correlation ID; secrets are redacted (PRD 11.1). */
export function createLoggerModule(service: string, level: string) {
  return LoggerModule.forRoot({
    pinoHttp: {
      level,
      base: { service },
      // correlationMiddleware runs first and guarantees this header is set.
      genReqId: (req) => String(req.headers[CORRELATION_HEADER]),
      customProps: (req) => ({ correlationId: req.id }),
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          '*.password',
          '*.passwordHash',
          '*.refreshToken',
          '*.accessToken',
          '*.token',
        ],
        censor: '[redacted]',
      },
      autoLogging: { ignore: (req) => req.url?.startsWith('/health') ?? false },
    },
  });
}
