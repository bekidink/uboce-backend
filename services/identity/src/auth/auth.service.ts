import { createHash, randomUUID } from 'node:crypto';

import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { AppError, buildEvent, conflict, notFound, REDIS, toOutboxRow } from '@uboce/common';
import * as argon2 from 'argon2';
import type { Redis } from 'ioredis';

import { SERVICE_NAME } from '../config.js';
import { Prisma } from '../generated/prisma/client.js';
import { AccountMailer } from '../account/account-mailer.js';
import { SecretBox } from '../mfa/secret-box.js';
import { verifyTotp } from '../mfa/totp.js';
import { PrismaService } from '../prisma.service.js';
import { MFA_CHALLENGE_TTL_SECONDS } from '../tokens/token-signer.js';
import { type RequestMeta, securityEvent, SessionsService, type TokenResponse } from '../tokens/tokens.module.js';
import type { LoginDto, MfaChallengeDto, RegisterDto, UserProfileDto, VerifyMfaDto } from './auth.dto.js';
import { parseRefreshToken, secretMatches } from './refresh-token.js';
import { env } from '../config.js';

const invalidCredentials = () => new AppError(HttpStatus.UNAUTHORIZED, 'invalid_credentials', 'Email or password is incorrect');
const invalidRefresh = () => new AppError(HttpStatus.UNAUTHORIZED, 'invalid_refresh_token', 'Refresh token is invalid or expired');
const invalidMfa = () => new AppError(HttpStatus.UNAUTHORIZED, 'invalid_mfa_code', 'The code is invalid or the sign-in attempt expired');

const MAX_MFA_ATTEMPTS = 5;

// Used to keep login timing the same whether or not the email exists.
const DUMMY_HASH = argon2.hash('not-a-real-password-just-for-timing');

export const hashRecoveryCode = (code: string) =>
  createHash('sha256').update(code.replace(/[\s-]/g, '').toUpperCase()).digest('hex');

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly box = new SecretBox(env.MFA_ENCRYPTION_KEY);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly mailer: AccountMailer,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async register(dto: RegisterDto, meta: RequestMeta): Promise<TokenResponse> {
    const email = dto.email.trim().toLowerCase();
    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id });

    let result: { tokens: TokenResponse; userId: string };
    try {
      result = await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { email, phone: dto.phone, passwordHash, displayName: dto.displayName.trim(), locale: dto.locale ?? 'en' },
        });
        await tx.outboxEvent.create({
          data: toOutboxRow(
            buildEvent(SERVICE_NAME, 'UserRegistered', user.id, {
              userId: user.id,
              email: user.email,
              displayName: user.displayName,
              locale: user.locale === 'am' ? 'am' : 'en',
            }),
          ),
        });
        await securityEvent(tx, 'user_registered', user.id, meta);
        return { tokens: await this.sessions.issue(tx, user.id, randomUUID(), meta), userId: user.id };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw conflict('account_exists', 'An account with this email or phone already exists');
      }
      throw error;
    }

    // After commit and best effort: the account works without it; the user can ask for a resend.
    await this.mailer.sendEmailVerification(result.userId).catch((error) =>
      this.logger.warn(`Could not send verification email: ${error}`),
    );
    return result.tokens;
  }

  /** Password step. Accounts with MFA get a short-lived challenge instead of a session. */
  async login(dto: LoginDto, meta: RequestMeta): Promise<TokenResponse | MfaChallengeDto> {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email.trim().toLowerCase() } });
    const valid = await argon2.verify(user?.passwordHash ?? (await DUMMY_HASH), dto.password);

    if (!user || !valid) {
      await securityEvent(this.prisma, 'login_failed', user?.id ?? null, meta);
      throw invalidCredentials();
    }
    if (user.status !== 'active') {
      await securityEvent(this.prisma, 'login_blocked', user.id, meta, { status: user.status });
      throw new AppError(HttpStatus.FORBIDDEN, 'account_inactive', 'This account is not active');
    }

    if (user.mfaEnabledAt) {
      await securityEvent(this.prisma, 'mfa_challenge_issued', user.id, meta);
      return {
        mfaRequired: true,
        mfaToken: await this.sessions.signer.signMfaChallenge(user.id),
        expiresIn: MFA_CHALLENGE_TTL_SECONDS,
      };
    }

    return this.prisma.$transaction(async (tx) => {
      await securityEvent(tx, 'login_succeeded', user.id, meta);
      return this.sessions.issue(tx, user.id, randomUUID(), meta);
    });
  }

  /** Second step: a TOTP code or a one-time recovery code completes the sign-in. */
  async verifyMfa(dto: VerifyMfaDto, meta: RequestMeta): Promise<TokenResponse> {
    const challenge = await this.sessions.signer.verifyMfaChallenge(dto.mfaToken).catch(() => {
      throw invalidMfa();
    });

    const attemptsKey = `uboce:mfa-attempts:${challenge.challengeId}`;
    const attempts = await this.redis.incr(attemptsKey);
    if (attempts === 1) await this.redis.expire(attemptsKey, MFA_CHALLENGE_TTL_SECONDS);
    if (attempts > MAX_MFA_ATTEMPTS) throw new AppError(HttpStatus.TOO_MANY_REQUESTS, 'too_many_attempts', 'Sign in again');

    const user = await this.prisma.user.findUnique({ where: { id: challenge.userId } });
    if (!user?.mfaEnabledAt || !user.mfaSecret || user.status !== 'active') throw invalidMfa();

    let method: 'totp' | 'recovery_code';
    if (dto.code) {
      const step = verifyTotp(this.box.open(user.mfaSecret), dto.code);
      // A code is valid for ~90 s; refuse to accept the same one twice.
      const fresh = step !== null && (await this.redis.set(`uboce:totp-used:${user.id}:${step}`, '1', 'EX', 120, 'NX'));
      if (!fresh) {
        await securityEvent(this.prisma, 'mfa_failed', user.id, meta);
        throw invalidMfa();
      }
      method = 'totp';
    } else if (dto.recoveryCode) {
      const { count } = await this.prisma.recoveryCode.updateMany({
        where: { userId: user.id, codeHash: hashRecoveryCode(dto.recoveryCode), usedAt: null },
        data: { usedAt: new Date() },
      });
      if (count === 0) {
        await securityEvent(this.prisma, 'mfa_failed', user.id, meta);
        throw invalidMfa();
      }
      method = 'recovery_code';
    } else {
      throw invalidMfa();
    }

    // One challenge, one session.
    const first = await this.redis.set(`uboce:mfa-done:${challenge.challengeId}`, '1', 'EX', MFA_CHALLENGE_TTL_SECONDS, 'NX');
    if (!first) throw invalidMfa();

    return this.prisma.$transaction(async (tx) => {
      await securityEvent(tx, 'login_succeeded', user.id, meta, { mfa: method });
      return this.sessions.issue(tx, user.id, randomUUID(), meta);
    });
  }

  /**
   * Rotates a refresh token. Each token works once: presenting one that was
   * already rotated means it leaked (or was replayed), so the whole session
   * family is revoked and the device has to sign in again.
   */
  async refresh(refreshToken: string, meta: RequestMeta): Promise<TokenResponse> {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) throw invalidRefresh();

    const session = await this.prisma.session.findUnique({ where: { id: parsed.sessionId }, include: { user: true } });
    if (!session || !secretMatches(parsed.secret, session.tokenHash)) throw invalidRefresh();
    if (session.revokedAt || session.expiresAt <= new Date() || session.user.status !== 'active') throw invalidRefresh();

    const reuse = async () => {
      await this.sessions.revokeFamily(session.familyId);
      await securityEvent(this.prisma, 'refresh_reuse_detected', session.userId, meta, { familyId: session.familyId });
      return invalidRefresh();
    };
    if (session.rotatedAt) throw await reuse();

    const rotated = await this.prisma.$transaction(async (tx) => {
      // Conditional update: two concurrent refreshes with the same token can't both win.
      const { count } = await tx.session.updateMany({
        where: { id: session.id, rotatedAt: null },
        data: { rotatedAt: new Date() },
      });
      if (count === 0) return null;
      return this.sessions.issue(tx, session.userId, session.familyId, meta);
    });
    if (!rotated) throw await reuse();
    return rotated;
  }

  /** Signs out this device: its whole refresh-token family stops working, including live access tokens. */
  async logout(userId: string, sessionId: string, meta: RequestMeta) {
    const familyId = await this.sessions.familyOf(sessionId);
    if (familyId) await this.sessions.revokeFamily(familyId);
    await securityEvent(this.prisma, 'logout', userId, meta);
  }

  async logoutAll(userId: string, meta: RequestMeta) {
    await this.sessions.revokeAllForUser(userId);
    await securityEvent(this.prisma, 'logout_all', userId, meta);
  }

  async profile(userId: string): Promise<UserProfileDto> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw notFound('User');
    return {
      id: user.id,
      email: user.email,
      emailVerified: !!user.emailVerifiedAt,
      phone: user.phone,
      displayName: user.displayName,
      locale: user.locale,
      status: user.status,
      mfaEnabled: !!user.mfaEnabledAt,
      createdAt: user.createdAt,
    };
  }
}
