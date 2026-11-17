import { hostname } from 'node:os';

import { type BeforeApplicationShutdown, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { emitEvent, IdentityClient, InternalCallError, InternalClient, JobRegistry, MessagesClient, notFound, serviceUrl } from '@uboce/common';
import type { JobRunResult } from '@uboce/contracts';

import { env, SERVICE_NAME } from '../config.js';
import type { JobDefinition } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma.service.js';
import { JOB_CATALOG, jobName } from './catalog.js';

const ALERT_REPEAT_MS = 6 * 3_600_000;

/**
 * Runs the platform's time-based work (PRD v2 PLT-02). Each tick claims due
 * jobs with a conditional update, so however many administration instances run,
 * one job runs on one instance at a time. The job itself runs on its owning
 * service, through POST /internal/jobs/:job with a service token. A job that
 * was due while the scheduler was down runs once on restart, not once per missed slot.
 */
@Injectable()
export class SchedulerService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(SchedulerService.name);
  private readonly instance = `${hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
  private readonly http: InternalClient;
  private timer: NodeJS.Timeout | null = null;
  private running = 0;
  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly local: JobRegistry,
    private readonly identity: IdentityClient,
    private readonly messages: MessagesClient,
  ) {
    // Jobs may take minutes; the shared client's 3 s timeout is for request paths.
    this.http = new InternalClient({
      identityUrl: env.IDENTITY_URL,
      clientId: env.SERVICE_CLIENT_ID,
      clientSecret: env.SERVICE_CLIENT_SECRET,
      timeoutMs: env.SCHEDULER_JOB_TIMEOUT_SECONDS * 1000,
    });
    local.register('scheduler.purge-runs', () => this.purgeRuns());
  }

  async onApplicationBootstrap() {
    await this.syncCatalog();
    if (!env.SCHEDULER_ENABLED) {
      this.logger.warn('Scheduler is off (SCHEDULER_ENABLED=false); jobs will not run from this instance');
      return;
    }
    this.timer = setInterval(() => void this.tick(), env.SCHEDULER_TICK_SECONDS * 1000);
    this.timer.unref();
  }

  beforeApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  /** New catalog entries are added; existing ones keep the interval and switch an administrator set. */
  async syncCatalog() {
    const now = new Date();
    await this.prisma.jobDefinition.createMany({
      data: JOB_CATALOG.map((spec) => ({
        name: jobName(spec),
        service: spec.service,
        job: spec.job,
        description: spec.description,
        intervalSeconds: spec.intervalSeconds,
        timeoutSeconds: spec.timeoutSeconds ?? 120,
        // Spread first runs over a few minutes instead of firing everything at boot.
        nextRunAt: new Date(now.getTime() + Math.floor(Math.random() * 300_000)),
      })),
      skipDuplicates: true,
    });
  }

  async tick(now = new Date()) {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.flagMissed(now);
      const free = env.SCHEDULER_CONCURRENCY - this.running;
      if (free <= 0) return;
      const due = await this.prisma.jobDefinition.findMany({
        where: { enabled: true, nextRunAt: { lte: now }, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
        orderBy: { nextRunAt: 'asc' },
        take: free,
      });
      for (const def of due) {
        if (await this.claim(def, now)) void this.execute(def);
      }
    } catch (error) {
      this.logger.error(`Scheduler tick failed: ${(error as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  private async claim(def: JobDefinition, now: Date) {
    const { count } = await this.prisma.jobDefinition.updateMany({
      where: { name: def.name, enabled: true, nextRunAt: { lte: now }, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
      data: { lockedUntil: new Date(now.getTime() + (def.timeoutSeconds + 30) * 1000), lockedBy: this.instance },
    });
    if (count === 1 && def.lockedUntil) {
      // The previous holder's lock ran out: its run never finished.
      await this.prisma.jobRun.updateMany({ where: { jobName: def.name, status: 'running' }, data: { status: 'abandoned', finishedAt: now, error: 'lock expired before the run finished' } });
    }
    return count === 1;
  }

  private async execute(def: JobDefinition) {
    this.running++;
    const started = Date.now();
    const run = await this.prisma.jobRun.create({ data: { jobName: def.name, instance: this.instance } });
    let status: 'succeeded' | 'failed' | 'skipped' = 'succeeded';
    let result: JobRunResult | null = null;
    let error: string | null = null;
    try {
      const target = this.targetUrl(def.service);
      if (def.service === 'administration') result = await this.local.run(def.job);
      else if (!target) {
        status = 'skipped';
        error = `${def.service.toUpperCase()}_URL is not configured`;
      } else result = await this.http.post<JobRunResult>(`${serviceUrl(target)}/api/v1/internal/jobs/${encodeURIComponent(def.job)}`, {});
    } catch (e) {
      status = 'failed';
      error = describe(e);
    } finally {
      this.running--;
    }

    const finished = new Date();
    const failures = status === 'failed' ? def.consecutiveFailures + 1 : status === 'succeeded' ? 0 : def.consecutiveFailures;
    await this.prisma.jobRun.update({
      where: { id: run.id },
      data: { status, processed: result?.processed ?? null, detail: (result?.detail as object | undefined) ?? undefined, error, finishedAt: finished, durationMs: Date.now() - started },
    });
    // Released only if we still hold the claim; next run counts from now, so a backlog never piles up.
    await this.prisma.jobDefinition.updateMany({
      where: { name: def.name, lockedBy: this.instance },
      data: {
        lockedUntil: null,
        lockedBy: null,
        nextRunAt: new Date(finished.getTime() + def.intervalSeconds * 1000),
        lastRunAt: finished,
        lastStatus: status,
        lastError: error,
        consecutiveFailures: failures,
        ...(status === 'succeeded' ? { alertedAt: null } : {}),
      },
    });
    if (status === 'failed') {
      this.logger.warn(`Job ${def.name} failed (${failures} in a row): ${error}`);
      if (failures >= env.SCHEDULER_ALERT_AFTER_FAILURES) await this.alert(def, 'failed', failures, error);
    }
  }

  /** A job overdue by three intervals (and at least an hour) is reported once until it runs again. */
  private async flagMissed(now: Date) {
    const candidates = await this.prisma.jobDefinition.findMany({
      where: { enabled: true, nextRunAt: { lt: new Date(now.getTime() - 3_600_000) }, alertedAt: null },
      take: 50,
    });
    for (const def of candidates) {
      const lateBy = now.getTime() - def.nextRunAt.getTime();
      if (lateBy >= Math.max(3 * def.intervalSeconds * 1000, 3_600_000)) await this.alert(def, 'missed', def.consecutiveFailures, def.lastError);
    }
  }

  private async alert(def: JobDefinition, kind: 'failed' | 'missed', failures: number, error: string | null) {
    const now = new Date();
    const { count } = await this.prisma.jobDefinition.updateMany({
      where: { name: def.name, OR: [{ alertedAt: null }, { alertedAt: { lt: new Date(now.getTime() - ALERT_REPEAT_MS) } }] },
      data: { alertedAt: now },
    });
    if (count === 0) return;
    await this.prisma.$transaction((tx) =>
      emitEvent(tx, SERVICE_NAME, 'JobFailed', def.name, { job: def.job, service: def.service, kind, consecutiveFailures: failures, error: error?.slice(0, 500) ?? null }),
    );
    // Email platform administrators; an outage here must not break the scheduler.
    try {
      const admins = await this.prisma.platformRoleGrant.findMany({ where: { role: 'platform_admin', revokedAt: null }, select: { userId: true }, distinct: ['userId'] });
      for (const { userId } of admins) {
        const user = await this.identity.getUser(userId);
        if (!user?.email || user.status !== 'active') continue;
        await this.messages.send({
          channel: 'email',
          to: user.email,
          template: 'job_failed',
          locale: user.locale === 'am' ? 'am' : 'en',
          vars: { job: def.name, kind, failures: String(failures), error: (error ?? '').slice(0, 300) },
          userId,
        });
      }
    } catch (e) {
      this.logger.error(`Could not email the job alert for ${def.name}: ${describe(e)}`);
    }
  }

  private targetUrl(service: string) {
    return process.env[`${service.toUpperCase()}_URL`];
  }

  async purgeRuns() {
    const { count } = await this.prisma.jobRun.deleteMany({ where: { startedAt: { lt: new Date(Date.now() - 30 * 86_400_000) } } });
    return count;
  }

  // ---- Administration API ----------------------------------------------------------------

  async list() {
    const defs = await this.prisma.jobDefinition.findMany({ orderBy: [{ service: 'asc' }, { job: 'asc' }] });
    const now = Date.now();
    return defs.map((d) => ({ ...d, running: !!d.lockedUntil && d.lockedUntil.getTime() > now, overdueSeconds: Math.max(0, Math.floor((now - d.nextRunAt.getTime()) / 1000)) }));
  }

  async runs(name: string, limit: number) {
    await this.get(name);
    return this.prisma.jobRun.findMany({ where: { jobName: name }, orderBy: { startedAt: 'desc' }, take: limit });
  }

  async update(name: string, dto: { enabled?: boolean; intervalSeconds?: number }) {
    await this.get(name);
    return this.prisma.jobDefinition.update({ where: { name }, data: { ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}), ...(dto.intervalSeconds ? { intervalSeconds: dto.intervalSeconds } : {}) } });
  }

  /** Runs at the next tick (within SCHEDULER_TICK_SECONDS); handlers are idempotent, so an extra run is safe. */
  async runNow(name: string) {
    await this.get(name);
    return this.prisma.jobDefinition.update({ where: { name }, data: { nextRunAt: new Date() } });
  }

  private async get(name: string) {
    const def = await this.prisma.jobDefinition.findUnique({ where: { name } });
    if (!def) throw notFound('Job');
    return def;
  }
}

function describe(e: unknown) {
  if (e instanceof InternalCallError) return `${e.status}: ${JSON.stringify(e.body).slice(0, 300)}`;
  return (e as Error)?.message ?? String(e);
}
