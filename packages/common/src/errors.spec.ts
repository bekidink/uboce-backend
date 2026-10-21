import { BadRequestException, HttpStatus } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { AllExceptionsFilter, AppError } from './errors.js';

const hostFor = (res: { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> }) =>
  ({ switchToHttp: () => ({ getResponse: () => res }) }) as never;

const run = (exception: unknown) => {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  new AllExceptionsFilter().catch(exception, hostFor(res));
  return { status: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0] };
};

describe('AllExceptionsFilter', () => {
  it('keeps the code of domain errors', () => {
    const { status, body } = run(new AppError(HttpStatus.CONFLICT, 'email_taken', 'Email already registered'));
    expect(status).toBe(409);
    expect(body.error).toEqual({ code: 'email_taken', message: 'Email already registered' });
  });

  it('reports validation failures with details', () => {
    const { status, body } = run(new BadRequestException(['email must be an email']));
    expect(status).toBe(400);
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details).toEqual(['email must be an email']);
  });

  it('hides unexpected errors', () => {
    const { status, body } = run(new Error('db password is hunter2'));
    expect(status).toBe(500);
    expect(body.error).toEqual({ code: 'internal_error', message: 'Something went wrong' });
  });
});
