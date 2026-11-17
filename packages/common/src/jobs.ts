import { Controller, type DynamicModule, Global, HttpCode, Injectable, Logger, Module, NotFoundException, Param, Post, type Type } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { JobRunResult } from '@uboce/contracts';

import { Internal } from './auth/decorators.js';

export type JobHandler = () => Promise<JobRunResult | number | void>;

/**
 * The scheduled work a service owns (PRD v2 PLT-02). Handlers must be
 * idempotent: the scheduler may call one again after a timeout or restart.
 */
@Injectable()
export class JobRegistry {
  private readonly logger = new Logger(JobRegistry.name);
  private readonly handlers = new Map<string, JobHandler>();

  register(name: string, handler: JobHandler) {
    if (this.handlers.has(name)) throw new Error(`Job ${name} is registered twice`);
    this.handlers.set(name, handler);
  }

  names() {
    return [...this.handlers.keys()].sort();
  }

  async run(name: string): Promise<JobRunResult> {
    const handler = this.handlers.get(name);
    if (!handler) throw new NotFoundException(`No job named ${name}`);
    const started = Date.now();
    const out = await handler();
    const result: JobRunResult = typeof out === 'number' ? { processed: out } : (out ?? { processed: 0 });
    if (result.processed > 0) this.logger.log(`Job ${name} processed ${result.processed} in ${Date.now() - started} ms`);
    return result;
  }
}

/** Only the scheduler (in administration) triggers jobs. */
@ApiExcludeController()
@Controller('internal/jobs')
export class InternalJobsController {
  constructor(private readonly jobs: JobRegistry) {}

  @Internal('administration')
  @Post(':job')
  @HttpCode(200)
  run(@Param('job') job: string) {
    return this.jobs.run(job);
  }
}

interface RawSql {
  $executeRawUnsafe: (query: string) => Promise<number>;
}

const days = (name: string, fallback: number) => Math.max(1, Math.floor(Number(process.env[name]) || fallback));

const RETENTION = [
  // Published events stay available for replay to consumers that fell behind.
  { table: 'outbox_events', where: `published_at IS NOT NULL AND published_at < now() - interval '${days('OUTBOX_RETENTION_DAYS', 30)} days'` },
  // The inbox only has to outlive redelivery of the same event.
  { table: 'processed_events', where: "processed_at < now() - interval '30 days'" },
];

/** Deletes old processed events in batches, skipping tables a service doesn't have (PLT-09). */
export async function purgeEventTables(prisma: RawSql): Promise<JobRunResult> {
  let processed = 0;
  for (const { table, where } of RETENTION) {
    try {
      for (let i = 0; i < 50; i++) {
        const n = await prisma.$executeRawUnsafe(`DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${where} LIMIT 5000)`);
        processed += n;
        if (n < 5000) break;
      }
    } catch (error) {
      if (!/does not exist|42P01/.test(String(error))) throw error;
    }
  }
  return { processed };
}

@Injectable()
class HousekeepingJobs {
  constructor(registry: JobRegistry, prisma: RawSql) {
    registry.register('housekeeping.events', () => purgeEventTables(prisma));
  }
}

/** Registry, the internal trigger endpoint and the standard housekeeping job. */
@Global()
@Module({})
export class JobsModule {
  static forRoot(prismaService: Type<unknown>): DynamicModule {
    return {
      module: JobsModule,
      controllers: [InternalJobsController],
      providers: [
        JobRegistry,
        { provide: HousekeepingJobs, useFactory: (r: JobRegistry, p: RawSql) => new HousekeepingJobs(r, p), inject: [JobRegistry, prismaService] },
      ],
      exports: [JobRegistry],
    };
  }
}
