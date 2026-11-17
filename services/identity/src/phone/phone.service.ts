import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { AppError, badRequest, conflict, hitRateLimit, maskPhone, MessagesClient, normalizePhone, REDIS, verifyHuman } from '@uboce/common';
import type { Redis } from 'ioredis';

import { env } from '../config.js';
import { Prisma } from '../generated/prisma/client.js';
import type { PhonePurpose } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma.service.js';
import { MFA_CHALLENGE_TTL_SECONDS } from '../tokens/token-signer.js';
import { type RequestMeta, securityEvent, SessionsService } from '../tokens/tokens.module.js';

const CODE_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const MINUTE = 60_000;

const invalidCode = () => new AppError(HttpStatus.UNAUTHORIZED, 'invalid_code', 'The code is wrong or has expired');
const tooMany = (retryAfterMs: number) =>
  new AppError(HttpStatus.TOO_MANY_REQUESTS, 'too_many_codes', `Too many codes requested; try again in ${Math.max(1, Math.ceil(retryAfterMs / MINUTE))} minute(s)`);

/**
 * Phone verification and phone sign-in by SMS code (PRD v2 ORG-01, NTF-03).
 * Codes are 6 digits, stored only as an HMAC, valid for 10 minutes and 5
 * attempts. Requests are limited per phone, per IP and per account, and a
 * login request never reveals whether the number has an account.
 */
@Injectable()
export class PhoneService {
  private readonly logger = new Logger(PhoneService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly messages: MessagesClient,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Signed-in user: send a code to a number they want to add or confirm. */
  async startVerification(userId: string, rawPhone: string, meta: RequestMeta) {
    const phone = this.parse(rawPhone);
    const taken = await this.prisma.user.findFirst({ where: { phone, id: { not: userId }, phoneVerifiedAt: { not: null } }, select: { id: true } });
    if (taken) throw conflict('phone_in_use', 'That number is already verified on another account');
    await this.limit([`phone:${phone}`, `user:${userId}`], meta);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    await this.issue(phone, 'verify', userId, user.locale, meta);
    return { sentTo: maskPhone(phone), expiresIn: CODE_TTL_MINUTES * 60 };
  }

  async confirmVerification(userId: string, rawPhone: string, code: string, meta: RequestMeta) {
    const phone = this.parse(rawPhone);
    await this.consume(phone, 'verify', code, userId);
    try {
      await this.prisma.$transaction(async (tx) => {
        // An unverified claim on the same number elsewhere is released: only proof of possession counts.
        await tx.user.updateMany({ where: { phone, id: { not: userId }, phoneVerifiedAt: null }, data: { phone: null } });
        await tx.user.update({ where: { id: userId }, data: { phone, phoneVerifiedAt: new Date() } });
        await securityEvent(tx, 'phone_verified', userId, meta, { phone: maskPhone(phone) });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw conflict('phone_in_use', 'That number is already verified on another account');
      throw error;
    }
    return { phone, verified: true };
  }

  /** Public: send a sign-in code. Same answer whether or not the number has an account. */
  async startLogin(rawPhone: string, captchaToken: string | undefined, meta: RequestMeta) {
    if (!(await verifyHuman(captchaToken, meta.ipAddress))) throw new AppError(HttpStatus.FORBIDDEN, 'captcha_failed', 'Complete the check that you are not a robot');
    const phone = this.parse(rawPhone);
    await this.limit([`phone:${phone}`], meta);
    const user = await this.prisma.user.findFirst({ where: { phone, phoneVerifiedAt: { not: null }, status: 'active' } });
    if (user) await this.issue(phone, 'login', user.id, user.locale, meta);
    else await securityEvent(this.prisma, 'phone_login_unknown', null, meta, { phone: maskPhone(phone) });
    return { sentTo: maskPhone(phone), expiresIn: CODE_TTL_MINUTES * 60 };
  }

  /** Public: the code signs in, or asks for the second factor when the account has one. */
  async verifyLogin(rawPhone: string, code: string, meta: RequestMeta) {
    const phone = this.parse(rawPhone);
    const userId = await this.consume(phone, 'login', code, null);
    const user = await this.prisma.user.findUnique({ where: { id: userId! } });
    if (!user || user.status !== 'active' || user.phone !== phone || !user.phoneVerifiedAt) throw invalidCode();
    if (user.mfaEnabledAt) {
      await securityEvent(this.prisma, 'mfa_challenge_issued', user.id, meta, { via: 'phone' });
      return { mfaRequired: true as const, mfaToken: await this.sessions.signer.signMfaChallenge(user.id), expiresIn: MFA_CHALLENGE_TTL_SECONDS };
    }
    return this.prisma.$transaction(async (tx) => {
      await securityEvent(tx, 'login_succeeded', user.id, meta, { via: 'phone' });
      return this.sessions.issue(tx, user.id, randomUUID(), meta);
    });
  }

  // ---- internals -----------------------------------------------------------------------

  private parse(raw: string) {
    const phone = normalizePhone(raw);
    if (!phone) throw badRequest('invalid_phone', 'Enter a mobile number, e.g. 0911 234 567 or +251 911 234 567');
    return phone;
  }

  /** 1 per minute and 5 per day per key; 20 per hour per IP. */
  private async limit(keys: string[], meta: RequestMeta) {
    const checks = keys.flatMap((k) => [
      hitRateLimit(this.redis, `sms-code:min:${k}`, MINUTE, 1),
      hitRateLimit(this.redis, `sms-code:day:${k}`, 24 * 60 * MINUTE, env.PHONE_CODES_PER_DAY),
    ]);
    if (meta.ipAddress) checks.push(hitRateLimit(this.redis, `sms-code:ip:${meta.ipAddress}`, 60 * MINUTE, 20));
    const results = await Promise.all(checks);
    const hit = results.find((r) => r.limited);
    if (hit) throw tooMany(hit.retryAfterMs);
  }

  private async issue(phone: string, purpose: PhonePurpose, userId: string, locale: string, meta: RequestMeta) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const id = randomUUID();
    await this.prisma.$transaction(async (tx) => {
      // A new code replaces any earlier one for the same number and purpose.
      await tx.phoneVerification.updateMany({ where: { phone, purpose, consumedAt: null }, data: { consumedAt: new Date() } });
      await tx.phoneVerification.create({
        data: { id, phone, purpose, userId, codeHash: hashCode(id, code), expiresAt: new Date(Date.now() + CODE_TTL_MINUTES * MINUTE), ipAddress: meta.ipAddress ?? null },
      });
    });
    try {
      await this.messages.send({ channel: 'sms', to: phone, template: 'phone_code', locale: locale === 'am' ? 'am' : 'en', userId, vars: { code, minutes: String(CODE_TTL_MINUTES) } });
    } catch (error) {
      this.logger.error(`Could not send a code to ${maskPhone(phone)}: ${(error as Error).message}`);
      throw new AppError(HttpStatus.BAD_GATEWAY, 'sms_failed', 'We could not send the code; try again shortly');
    }
  }

  /** Checks the code against the newest open request; returns the user it was issued for. */
  private async consume(phone: string, purpose: PhonePurpose, code: string, userId: string | null) {
    const row = await this.prisma.phoneVerification.findFirst({
      where: { phone, purpose, consumedAt: null, expiresAt: { gt: new Date() }, ...(userId ? { userId } : {}) },
      orderBy: { createdAt: 'desc' },
    });
    if (!row || row.attempts >= MAX_ATTEMPTS) throw invalidCode();
    const ok = /^\d{6}$/.test(code) && safeEqual(row.codeHash, hashCode(row.id, code));
    if (!ok) {
      await this.prisma.phoneVerification.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
      throw invalidCode();
    }
    // Single use, even under concurrent requests.
    const { count } = await this.prisma.phoneVerification.updateMany({ where: { id: row.id, consumedAt: null }, data: { consumedAt: new Date() } });
    if (count === 0) throw invalidCode();
    return row.userId;
  }
}

const hashCode = (id: string, code: string) => createHmac('sha256', env.MFA_ENCRYPTION_KEY).update(`${id}:${code}`).digest('hex');

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
