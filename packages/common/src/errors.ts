import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

import { currentCorrelationId } from './context.js';

/** Domain error with a stable machine-readable `code` clients can branch on. */
export class AppError extends HttpException {
  constructor(status: HttpStatus, code: string, message: string, details?: unknown) {
    super({ code, message, details }, status);
  }
}

export const notFound = (what: string) => new AppError(HttpStatus.NOT_FOUND, 'not_found', `${what} not found`);
export const forbidden = (message = 'You do not have permission to perform this action') =>
  new AppError(HttpStatus.FORBIDDEN, 'forbidden', message);
export const conflict = (code: string, message: string) => new AppError(HttpStatus.CONFLICT, code, message);
export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(HttpStatus.BAD_REQUEST, code, message, details);

const DEFAULT_CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  422: 'unprocessable',
  429: 'rate_limited',
};

/**
 * One error shape for every service:
 * `{ error: { code, message, details? }, correlationId }`.
 * Unexpected errors are logged in full but never leak internals to clients.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'internal_error';
    let message = 'Something went wrong';
    let details: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = DEFAULT_CODES[status] ?? 'error';
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else if (body && typeof body === 'object') {
        const b = body as { code?: string; message?: string | string[]; details?: unknown };
        if (Array.isArray(b.message)) {
          // class-validator failures from ValidationPipe.
          code = 'validation_failed';
          message = 'Request validation failed';
          details = b.message;
        } else {
          code = b.code ?? code;
          message = b.message ?? exception.message;
          details = b.details;
        }
      }
    } else {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }

    res.status(status).json({
      error: { code, message, ...(details === undefined ? {} : { details }) },
      correlationId: currentCorrelationId(),
    });
  }
}
