import { randomBytes } from 'node:crypto';

import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { AppError, conflict, REDIS } from '@uboce/common';
import * as argon2 from 'argon2';
import type { Redis } from 'ioredis';

import { hashRecoveryCode } from '../auth/auth.service.js';
import { env } from '../config.js';
import type { TokenPurpose } from '../generated/prisma/enums.js';
import { SecretBox } from '../mfa/secret-box.js';
import { base32Encode, generateTotpSecret, otpauthUrl, verifyTotp } from '../mfa/totp.js';
import { PrismaService } from '../prisma.service.js';
import { type RequestMeta, securityEvent, SessionsService } from '../tokens/tokens.module.js';
import { AccountMailer, hashEmailToken } from './account-mailer.js';

const invalidToken = () => new AppError(HttpStatus.BAD_REQUEST, 'invalid_token', 'This link is invalid or has expired');
const invalidCode = () => new AppError(HttpStatus.BAD_REQUEST, 'invalid_mfa_code', 'The code is not valid');

const RECOVERY_CODE_COUNT = 10;

@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);
  private readonly box = new SecretBox(env.MFA_ENCRYPTION_KEY);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly mailer: AccountMailer,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  // ---- Email verification -----------------------------------------------------

  async verifyEmail(token: string, meta: RequestMeta) {
    const record = await this.consumeToken(token, 'email_verification');
    await this.prisma.user.update({ where: { id: record.userId }, data: { emailVerifiedAt: new Date() } });
    await securityEvent(this.prisma, 'email_verified', record.userId, meta);
  }

  async resendVerification(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.emailVerifiedAt) throw conflict('already_verified', 'This email address is already verified');
    await this.mailer.sendEmailVerification(userId);
  }

  // ---- Passwords --------------------------------------------------------------

  /** Always succeeds from the caller's view, so it can't be used to find out which emails have accounts. */
  async forgotPassword(email: string, meta: RequestMeta) {
    const user = await this.prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (!user || user.status !== 'active') return;
    await securityEvent(this.prisma, 'password_reset_requested', user.id, meta);
    await this.mailer.sendPasswordReset(user.id).catch((error) => this.logger.warn(`Reset email failed: ${error}`));
  }

  /** Sets a new password and signs the user out everywhere. */
  async resetPassword(token: string, newPassword: string, meta: RequestMeta) {
    const record = await this.consumeToken(token, 'password_reset');
    await this.prisma.user.update({
      where: { id: record.userId },
      data: { passwordHash: await argon2.hash(newPassword, { type: argon2.argon2id }) },
    });
    await this.sessions.revokeAllForUser(record.userId);
    await securityEvent(this.prisma, 'password_reset', record.userId, meta);
  }

  /** Keeps this device signed in; every other device is signed out. */
  async changePassword(userId: string, sessionId: string, current: string, next: string, meta: RequestMeta) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await argon2.verify(user.passwordHash, current))) {
      await securityEvent(this.prisma, 'password_change_failed', userId, meta);
      throw new AppError(HttpStatus.BAD_REQUEST, 'invalid_password', 'Current password is incorrect');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await argon2.hash(next, { type: argon2.argon2id }) },
    });
    await this.sessions.revokeAllForUser(userId, await this.sessions.familyOf(sessionId));
    await securityEvent(this.prisma, 'password_changed', userId, meta);
  }

  // ---- MFA (TOTP) ---------------------------------------------------------------

  /** Step 1: a new secret for the authenticator app. Nothing changes until it's confirmed. */
  async startMfaSetup(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.mfaEnabledAt) throw conflict('mfa_already_enabled', 'Two-factor sign-in is already on');
    const secret = generateTotpSecret();
    await this.redis.set(`uboce:mfa-setup:${userId}`, this.box.seal(secret), 'EX', 15 * 60);
    return { secret, otpauthUrl: otpauthUrl(secret, user.email) };
  }

  /** Step 2: proving a code works turns MFA on and returns recovery codes, shown once. */
  async enableMfa(userId: string, code: string, meta: RequestMeta) {
    const sealed = await this.redis.get(`uboce:mfa-setup:${userId}`);
    if (!sealed) throw new AppError(HttpStatus.BAD_REQUEST, 'mfa_setup_expired', 'Start two-factor setup again');
    if (verifyTotp(this.box.open(sealed), code) === null) throw invalidCode();

    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
      const raw = base32Encode(randomBytes(10));
      return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
    });
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { mfaSecret: sealed, mfaEnabledAt: new Date() } }),
      this.prisma.recoveryCode.deleteMany({ where: { userId } }),
      this.prisma.recoveryCode.createMany({ data: codes.map((c) => ({ userId, codeHash: hashRecoveryCode(c) })) }),
    ]);
    await this.redis.del(`uboce:mfa-setup:${userId}`);
    await securityEvent(this.prisma, 'mfa_enabled', userId, meta);
    return { recoveryCodes: codes };
  }

  async disableMfa(userId: string, code: string, meta: RequestMeta) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.mfaEnabledAt || !user.mfaSecret) throw conflict('mfa_not_enabled', 'Two-factor sign-in is not on');
    if (verifyTotp(this.box.open(user.mfaSecret), code) === null) throw invalidCode();
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { mfaSecret: null, mfaEnabledAt: null } }),
      this.prisma.recoveryCode.deleteMany({ where: { userId } }),
    ]);
    await securityEvent(this.prisma, 'mfa_disabled', userId, meta);
  }

  /** Marks a single-use emailed token used, atomically, so it can't be redeemed twice. */
  private async consumeToken(token: string, purpose: TokenPurpose) {
    const record = await this.prisma.verificationToken.findUnique({ where: { tokenHash: hashEmailToken(token) } });
    if (!record || record.purpose !== purpose || record.usedAt || record.expiresAt <= new Date()) throw invalidToken();
    const { count } = await this.prisma.verificationToken.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (count === 0) throw invalidToken();
    return record;
  }
}
