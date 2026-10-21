import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { decodeBase64, REDIS, revokedSessionKey } from '@uboce/common';
import type { Redis } from 'ioredis';

import { env } from '../config.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma.service.js';
import { formatRefreshToken, hashSecret, newRefreshSecret } from '../auth/refresh-token.js';
import { TokenSigner } from './token-signer.js';

export interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

type Db = Prisma.TransactionClient | PrismaService;

/** Issues and revokes sessions; shared by login, MFA, registration and account changes. */
@Injectable()
export class SessionsService {
  readonly signer = new TokenSigner({
    privateKeyPem: decodeBase64(env.JWT_PRIVATE_KEY),
    publicKeyPem: decodeBase64(env.JWT_PUBLIC_KEY),
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    accessTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
    serviceTtlSeconds: env.SERVICE_TOKEN_TTL_SECONDS,
  });

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async issue(db: Db, userId: string, familyId: string, meta: RequestMeta): Promise<TokenResponse> {
    const secret = newRefreshSecret();
    const session = await db.session.create({
      data: {
        userId,
        familyId,
        tokenHash: hashSecret(secret),
        expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000),
        userAgent: meta.userAgent?.slice(0, 500),
        ipAddress: meta.ipAddress,
      },
    });
    return {
      accessToken: await this.signer.signAccess(userId, session.id),
      refreshToken: formatRefreshToken(session.id, secret),
      tokenType: 'Bearer',
      expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
    };
  }

  async revokeFamily(familyId: string) {
    await this.revokeWhere({ familyId });
  }

  /** Signs the user out everywhere, optionally keeping one device's session family. */
  async revokeAllForUser(userId: string, exceptFamilyId?: string) {
    await this.revokeWhere({ userId, ...(exceptFamilyId ? { familyId: { not: exceptFamilyId } } : {}) });
  }

  async familyOf(sessionId: string) {
    return (await this.prisma.session.findUnique({ where: { id: sessionId }, select: { familyId: true } }))?.familyId;
  }

  private async revokeWhere(where: Prisma.SessionWhereInput) {
    const sessions = await this.prisma.session.findMany({ where: { ...where, revokedAt: null }, select: { id: true } });
    if (sessions.length === 0) return;
    await this.prisma.session.updateMany({ where: { id: { in: sessions.map((s) => s.id) } }, data: { revokedAt: new Date() } });
    // Lets every service reject these sessions' live access tokens right away.
    const pipeline = this.redis.pipeline();
    for (const { id } of sessions) pipeline.set(revokedSessionKey(id), '1', 'EX', env.ACCESS_TOKEN_TTL_SECONDS);
    await pipeline.exec();
  }
}

export const securityEvent = (
  db: Db,
  type: string,
  userId: string | null,
  meta: RequestMeta,
  metadata?: Prisma.InputJsonValue,
) =>
  db.securityEvent.create({
    data: { type, userId, ipAddress: meta.ipAddress, userAgent: meta.userAgent?.slice(0, 500), metadata },
  });

@Global()
@Module({ providers: [SessionsService], exports: [SessionsService] })
export class TokensModule {}
