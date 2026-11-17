import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { AppError, badRequest, hitRateLimit, normalizePhone, type PaginationQueryDto, REDIS, skipTake, toPage } from '@uboce/common';
import type { EventEnvelope, SendMessageRequest } from '@uboce/contracts';
import type { Redis } from 'ioredis';

import { EMAIL_PROVIDER, type EmailProvider } from '../channels/email.provider.js';
import { SMS_PROVIDER, type SmsProvider, type SmsResult } from '../channels/sms.provider.js';
import { env } from '../config.js';
import { Prisma } from '../generated/prisma/client.js';
import type { DevicePlatform } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma.service.js';
import { PUSH_PROVIDER, type PushProvider } from '../push/push.provider.js';
import { isTemplateKey, maskAddress, render, type TemplateKey } from './templates.js';

export type Tx = Prisma.TransactionClient;

export interface NotifyRequest {
  userId: string;
  template: TemplateKey;
  vars: Record<string, string>;
}

export const MAX_PUSH_ATTEMPTS = 5;
/** Delay before attempt n+1 (index n-1): 1 min, 5 min, 15 min, 1 h. */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const nextRetry = (attemptCount: number) =>
  attemptCount >= MAX_PUSH_ATTEMPTS ? null : new Date(Date.now() + (RETRY_DELAYS_MS[attemptCount - 1] ?? 60 * 60_000));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PUSH_PROVIDER) private readonly push: PushProvider,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  // ---- Devices -------------------------------------------------------------

  /** A device token belongs to whoever signed in on that device most recently. */
  registerDevice(userId: string, token: string, platform: DevicePlatform) {
    return this.prisma.deviceToken.upsert({
      where: { token },
      update: { userId, platform, lastSeenAt: new Date() },
      create: { userId, token, platform },
    });
  }

  async unregisterDevice(userId: string, token: string) {
    await this.prisma.deviceToken.deleteMany({ where: { token, userId } });
  }

  // ---- Inbox (in-app notifications) ----------------------------------------

  async list(userId: string, query: PaginationQueryDto, unreadOnly: boolean) {
    const where: Prisma.NotificationWhereInput = { userId, channel: 'in_app', ...(unreadOnly ? { readAt: null } : {}) };
    const [items, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        select: { id: true, templateKey: true, title: true, body: true, data: true, readAt: true, createdAt: true },
        ...skipTake(query),
      }),
      this.prisma.notification.count({ where }),
    ]);
    return toPage(items, total, query);
  }

  async markRead(userId: string, notificationId: string) {
    await this.prisma.notification.updateMany({
      where: { id: notificationId, userId, readAt: null },
      data: { readAt: new Date() },
    });
  }

  async markAllRead(userId: string) {
    await this.prisma.notification.updateMany({
      where: { userId, channel: 'in_app', readAt: null },
      data: { readAt: new Date() },
    });
  }

  // ---- Event-driven notifications -----------------------------------------

  async setLocale(tx: Tx, userId: string, locale: string) {
    await tx.userPreference.upsert({ where: { userId }, update: { locale }, create: { userId, locale } });
  }

  /**
   * Handles an event exactly once per service: the inbox row and the
   * notifications commit together, so a redelivered event is a no-op.
   * Recipients are resolved before the transaction (they may need network
   * calls). Push goes out after commit; a failed send is retried by the job
   * and never undoes the notification (PRD 8.5).
   */
  async handleEventOnce(
    event: EventEnvelope,
    plan: { recipients: () => Promise<NotifyRequest[]>; inTransaction?: (tx: Tx) => Promise<void> },
  ) {
    if (await this.prisma.processedEvent.findUnique({ where: { eventId: event.eventId } })) return;
    const requests = await plan.recipients();

    let pushIds: string[];
    try {
      pushIds = await this.prisma.$transaction(async (tx) => {
        await tx.processedEvent.create({ data: { eventId: event.eventId, eventType: event.eventType } });
        await plan.inTransaction?.(tx);
        const ids: string[] = [];
        for (const request of requests) {
          const id = await this.createNotifications(tx, request, event.eventId);
          if (id) ids.push(id);
        }
        return ids;
      });
    } catch (error) {
      // Another consumer instance handled this event first.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return;
      throw error;
    }

    for (const id of pushIds) {
      await this.deliverPush(id).catch((error) => this.logger.error(`Push ${id} failed: ${error}`));
    }
  }

  /** Writes the in-app copy and, if the template and user allow it, a pending push. Returns the push ID. */
  private async createNotifications(tx: Tx, request: NotifyRequest, sourceEventId: string) {
    const preference = await tx.userPreference.findUnique({ where: { userId: request.userId } });
    const message = render(request.template, preference?.locale ?? 'en', request.vars);
    const base = {
      userId: request.userId,
      templateKey: request.template,
      locale: message.locale,
      title: message.title,
      body: message.body,
      data: message.route ? { route: message.route } : undefined,
      sourceEventId,
    };

    await tx.notification.create({ data: { ...base, channel: 'in_app', status: 'sent' } });
    if (!message.push || preference?.pushEnabled === false) return null;
    // nextAttemptAt is a safety net: if this process dies before sending, the retry job picks it up.
    const push = await tx.notification.create({
      data: { ...base, channel: 'push', status: 'pending', nextAttemptAt: new Date(Date.now() + 60_000) },
    });
    return push.id;
  }

  async deliverPush(notificationId: string) {
    const notification = await this.prisma.notification.findUniqueOrThrow({ where: { id: notificationId } });
    if (notification.status === 'sent' || notification.status === 'skipped') return;
    const devices = notification.userId
      ? await this.prisma.deviceToken.findMany({ where: { userId: notification.userId } })
      : [];
    if (devices.length === 0) {
      await this.prisma.notification.update({ where: { id: notificationId }, data: { status: 'skipped', nextAttemptAt: null } });
      return;
    }

    const data = (notification.data ?? {}) as Record<string, string>;
    let results;
    try {
      results = await this.push.send(
        devices.map((d) => d.token),
        { title: notification.title, body: notification.body, data: { ...data, notificationId } },
      );
    } catch (error) {
      results = devices.map((d) => ({ token: d.token, ok: false, invalidToken: false, error: String(error).slice(0, 200) }));
    }

    const delivered = results.some((r) => r.ok);
    const allDead = results.every((r) => r.invalidToken);
    const attemptCount = notification.attemptCount + 1;
    await this.prisma.$transaction([
      this.prisma.deliveryAttempt.createMany({
        data: results.map((r) => ({ notificationId, provider: this.push.name, success: r.ok, error: r.error })),
      }),
      this.prisma.deviceToken.deleteMany({ where: { token: { in: results.filter((r) => r.invalidToken).map((r) => r.token) } } }),
      this.prisma.notification.update({
        where: { id: notificationId },
        data: {
          status: delivered ? 'sent' : allDead ? 'skipped' : 'failed',
          attemptCount,
          nextAttemptAt: delivered || allDead ? null : nextRetry(attemptCount),
        },
      }),
    ]);
  }

  /** Called by the retry job. Claims each due push first so several instances never send it twice. */
  async retryDuePushes(limit = 50) {
    const now = new Date();
    const due = await this.prisma.notification.findMany({
      where: { channel: 'push', status: { in: ['pending', 'failed'] }, nextAttemptAt: { lte: now } },
      orderBy: { nextAttemptAt: 'asc' },
      select: { id: true },
      take: limit,
    });
    let retried = 0;
    for (const { id } of due) {
      const { count } = await this.prisma.notification.updateMany({
        where: { id, nextAttemptAt: { lte: now } },
        data: { nextAttemptAt: new Date(Date.now() + 5 * 60_000) },
      });
      if (count === 0) continue;
      await this.deliverPush(id).catch((error) => this.logger.error(`Retry of push ${id} failed: ${error}`));
      retried++;
    }
    return retried;
  }

  // ---- Direct email/SMS (internal API) -------------------------------------------

  /**
   * Sends right away with a few quick retries, because the caller is waiting
   * (e.g. a password reset request). Bodies of sensitive templates are never
   * stored — they hold one-time links.
   */
  async sendMessage(request: SendMessageRequest) {
    if (!isTemplateKey(request.template)) throw badRequest('unknown_template', `Unknown template ${request.template}`);
    const message = render(request.template, request.locale, request.vars);
    const provider = request.channel === 'email' ? this.email : this.sms;

    // SMS rules (PRD v2 NTF-02, NTF-04): E.164 numbers, a per-number cap, and a
    // monthly budget that stops everything except sign-in codes.
    if (request.channel === 'sms') {
      const to = normalizePhone(request.to);
      if (!to) throw badRequest('invalid_phone', 'Not a valid mobile number');
      request = { ...request, to };
      const rate = await hitRateLimit(this.redis, `sms:to:${to}`, 3_600_000, env.SMS_MAX_PER_NUMBER_PER_HOUR);
      if (rate.limited) throw new AppError(HttpStatus.TOO_MANY_REQUESTS, 'sms_rate_limited', 'Too many messages to this number; try again later');
      if (request.template !== 'phone_code' && env.SMS_MONTHLY_BUDGET > 0 && (await this.smsSpend()) >= env.SMS_MONTHLY_BUDGET) {
        this.logger.warn(`SMS budget for the month is spent; ${request.template} not sent`);
        await this.prisma.notification.create({
          data: { userId: request.userId ?? null, recipient: maskAddress(request.to), channel: 'sms', templateKey: request.template, locale: message.locale, title: message.title, body: message.sensitive ? '[not stored]' : message.body, status: 'skipped' },
        });
        return { status: 'skipped' };
      }
    }

    let lastError: unknown;
    let attempts = 0;
    let sms: SmsResult | null = null;
    for (; attempts < 3; attempts++) {
      if (attempts > 0) await sleep(200 * 2 ** attempts);
      try {
        if (request.channel === 'email') await this.email.send({ to: request.to, subject: message.title, text: message.body });
        else sms = await this.sms.send(request.to, message.body);
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    const cost = sms ? sms.segments * env.SMS_COST_PER_SEGMENT : null;
    if (cost) await this.addSmsSpend(cost);

    const notification = await this.prisma.notification.create({
      data: {
        userId: request.userId ?? null,
        recipient: maskAddress(request.to),
        channel: request.channel,
        templateKey: request.template,
        locale: message.locale,
        title: message.title,
        body: message.sensitive ? '[not stored: contains a one-time link]' : message.body,
        status: lastError ? 'failed' : 'sent',
        attemptCount: Math.min(attempts + 1, 3),
      },
    });
    await this.prisma.deliveryAttempt.create({
      data: {
        notificationId: notification.id,
        provider: provider.name,
        success: !lastError,
        error: lastError ? String(lastError).slice(0, 300) : null,
        providerMessageId: sms?.messageId ?? null,
        segments: sms?.segments ?? null,
        cost,
      },
    });

    if (lastError) {
      this.logger.error(`${request.channel} ${request.template} failed: ${lastError}`);
      throw new AppError(HttpStatus.BAD_GATEWAY, 'delivery_failed', `The ${request.channel} could not be sent`);
    }
    return { status: 'sent' };
  }

  // ---- SMS receipts and spend (PRD v2 NTF-02, NTF-07) ---------------------------------

  private spendKey(now = new Date()) {
    return `uboce:sms:spend:${now.toISOString().slice(0, 7)}`;
  }

  private async smsSpend() {
    return Number((await this.redis.get(this.spendKey())) ?? 0);
  }

  private async addSmsSpend(amount: number) {
    const key = this.spendKey();
    await this.redis.incrbyfloat(key, amount);
    await this.redis.expire(key, 40 * 86_400);
  }

  /** A gateway's delivery receipt: recorded on the attempt, so "I never got it" can be checked. */
  async smsReceipt(provider: string, messageId: string, status: 'delivered' | 'failed') {
    const { count } = await this.prisma.deliveryAttempt.updateMany({
      where: { provider, providerMessageId: messageId },
      data: { receiptStatus: status, receiptAt: new Date() },
    });
    return { updated: count > 0 };
  }

  /** This month's SMS volume and estimated cost, for administrators. */
  async smsUsage(month = new Date().toISOString().slice(0, 7)) {
    const from = new Date(`${month}-01T00:00:00Z`);
    const to = new Date(from);
    to.setUTCMonth(to.getUTCMonth() + 1);
    const rows = await this.prisma.deliveryAttempt.groupBy({
      by: ['receiptStatus'],
      where: { notification: { channel: 'sms' }, success: true, createdAt: { gte: from, lt: to } },
      _count: { _all: true },
      _sum: { segments: true, cost: true },
    });
    return {
      month,
      budget: env.SMS_MONTHLY_BUDGET || null,
      byReceipt: rows.map((r) => ({ receipt: r.receiptStatus ?? 'pending', messages: r._count._all, segments: r._sum.segments ?? 0, cost: r._sum.cost?.toString() ?? '0' })),
    };
  }
}
