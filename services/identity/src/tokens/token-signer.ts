import { randomUUID } from 'node:crypto';

import { INTERNAL_AUDIENCE } from '@uboce/contracts';
import { type CryptoKey, importPKCS8, importSPKI, jwtVerify, SignJWT } from 'jose';

export interface TokenSignerOptions {
  privateKeyPem: string;
  publicKeyPem: string;
  issuer: string;
  audience: string;
  accessTtlSeconds: number;
  serviceTtlSeconds: number;
}

/** Audience of the short-lived token that bridges password login and the MFA step. */
const MFA_AUDIENCE = 'uboce-mfa';
export const MFA_CHALLENGE_TTL_SECONDS = 300;

/**
 * Signs every token Identity issues. Three audiences keep them apart: user
 * access tokens, service tokens and MFA challenges can't be used for each other.
 */
export class TokenSigner {
  private privateKey: Promise<CryptoKey> | null = null;
  private publicKey: Promise<CryptoKey> | null = null;

  constructor(private readonly options: TokenSignerOptions) {}

  /** Short-lived user access token; `sid` ties it to a revocable session. */
  signAccess(userId: string, sessionId: string) {
    return this.sign({ sid: sessionId }, userId, this.options.audience, this.options.accessTtlSeconds);
  }

  signService(service: string) {
    return this.sign({ typ: 'service' }, `svc:${service}`, INTERNAL_AUDIENCE, this.options.serviceTtlSeconds);
  }

  signMfaChallenge(userId: string) {
    return this.sign({ typ: 'mfa' }, userId, MFA_AUDIENCE, MFA_CHALLENGE_TTL_SECONDS);
  }

  async verifyMfaChallenge(token: string): Promise<{ userId: string; challengeId: string }> {
    this.publicKey ??= importSPKI(this.options.publicKeyPem, 'RS256');
    const { payload } = await jwtVerify(token, await this.publicKey, {
      issuer: this.options.issuer,
      audience: MFA_AUDIENCE,
      algorithms: ['RS256'],
    });
    if (payload.typ !== 'mfa' || typeof payload.sub !== 'string' || typeof payload.jti !== 'string') {
      throw new Error('Not an MFA challenge');
    }
    return { userId: payload.sub, challengeId: payload.jti };
  }

  private async sign(claims: Record<string, unknown>, subject: string, audience: string, ttlSeconds: number) {
    this.privateKey ??= importPKCS8(this.options.privateKeyPem, 'RS256');
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setSubject(subject)
      .setIssuer(this.options.issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime(`${ttlSeconds}s`)
      .setJti(randomUUID())
      .sign(await this.privateKey);
  }
}
