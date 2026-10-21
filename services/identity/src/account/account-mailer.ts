import { createHash, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { MessagesClient } from '@uboce/common';

import { env } from '../config.js';
import type { TokenPurpose } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma.service.js';

const TTL_MS: Record<TokenPurpose, number> = {
  email_verification: 48 * 60 * 60 * 1000,
  password_reset: 30 * 60 * 1000,
};

export const hashEmailToken = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * Emails single-use links. Tokens go to Notification over the internal API
 * (not the event stream), so they're never persisted outside Identity's own
 * hashed copy.
 */
@Injectable()
export class AccountMailer {
  constructor(
    private readonly prisma: PrismaService,
    private readonly messages: MessagesClient,
  ) {}

  async sendEmailVerification(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.emailVerifiedAt) return;
    const token = await this.newToken(userId, 'email_verification');
    await this.messages.send({
      channel: 'email',
      to: user.email,
      template: 'email_verification',
      locale: user.locale,
      userId,
      vars: { name: user.displayName, link: `${env.APP_BASE_URL}/verify-email?token=${token}` },
    });
  }

  async sendPasswordReset(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const token = await this.newToken(userId, 'password_reset');
    await this.messages.send({
      channel: 'email',
      to: user.email,
      template: 'password_reset',
      locale: user.locale,
      userId,
      vars: { name: user.displayName, link: `${env.APP_BASE_URL}/reset-password?token=${token}` },
    });
  }

  /** Issuing a new token voids earlier unused ones for the same purpose. */
  private async newToken(userId: string, purpose: TokenPurpose) {
    const token = randomBytes(32).toString('base64url');
    await this.prisma.$transaction([
      this.prisma.verificationToken.updateMany({ where: { userId, purpose, usedAt: null }, data: { usedAt: new Date() } }),
      this.prisma.verificationToken.create({
        data: { userId, purpose, tokenHash: hashEmailToken(token), expiresAt: new Date(Date.now() + TTL_MS[purpose]) },
      }),
    ]);
    return token;
  }
}
