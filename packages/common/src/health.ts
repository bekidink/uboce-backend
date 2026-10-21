import { Controller, type DynamicModule, Get, HttpCode, Inject, Module, ServiceUnavailableException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

import { Public } from './auth/decorators.js';

export const HEALTH_CHECKS = Symbol('HEALTH_CHECKS');

export type HealthChecks = Record<string, () => Promise<unknown>>;

@ApiExcludeController()
@Public()
@Controller('health')
class HealthController {
  constructor(@Inject(HEALTH_CHECKS) private readonly checks: HealthChecks) {}

  /** Process is up. Used for restarts; never depends on other systems. */
  @Get('live')
  @HttpCode(200)
  live() {
    return { status: 'ok' };
  }

  /** Dependencies are reachable, so the service can take traffic (PRD 11.3). */
  @Get('ready')
  async ready() {
    const results = await Promise.all(
      Object.entries(this.checks).map(async ([name, check]) => {
        try {
          await withTimeout(check(), 2000);
          return [name, 'ok'] as const;
        } catch {
          return [name, 'down'] as const;
        }
      }),
    );
    const body = { status: results.every(([, s]) => s === 'ok') ? 'ok' : 'down', checks: Object.fromEntries(results) };
    if (body.status !== 'ok') throw new ServiceUnavailableException({ code: 'not_ready', message: 'Not ready', details: body.checks });
    return body;
  }
}

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

@Module({})
export class HealthModule {
  static forRootAsync(options: { useFactory: (...deps: any[]) => HealthChecks; inject?: any[] }): DynamicModule {
    return {
      module: HealthModule,
      controllers: [HealthController],
      providers: [{ provide: HEALTH_CHECKS, useFactory: options.useFactory, inject: options.inject ?? [] }],
    };
  }
}
