import { INTERNAL_AUDIENCE } from '@uboce/contracts';
import { type CryptoKey, importSPKI, jwtVerify } from 'jose';
import type { Redis } from 'ioredis';

export interface AuthUser {
  userId: string;
  sessionId: string;
}

/** A service calling an internal route, e.g. `{ service: 'procurement' }`. */
export interface ServiceCaller {
  service: string;
}

export interface TokenVerifierOptions {
  publicKeyPem: string;
  issuer: string;
  audience: string;
  /** When set, sessions Identity has revoked are rejected before their access token expires. */
  redis?: Redis;
}

/** Key Identity sets on logout/revocation, for the remaining lifetime of the session's access tokens. */
export const revokedSessionKey = (sessionId: string) => `uboce:revoked-session:${sessionId}`;

/**
 * Verifies Identity-issued RS256 tokens. Only Identity holds the private key,
 * so no other service can mint tokens (PRD 5.1: issuer, audience, expiry and
 * claims are all checked). User and service tokens have different audiences,
 * so neither can stand in for the other.
 */
export class AccessTokenVerifier {
  private key: Promise<CryptoKey> | null = null;

  constructor(private readonly options: TokenVerifierOptions) {}

  async verify(token: string): Promise<AuthUser> {
    const payload = await this.verifyFor(token, this.options.audience);
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
      throw new Error('Access token is missing required claims');
    }
    if (this.options.redis && (await this.options.redis.exists(revokedSessionKey(payload.sid)))) {
      throw new Error('Session has been revoked');
    }
    return { userId: payload.sub, sessionId: payload.sid };
  }

  async verifyService(token: string): Promise<ServiceCaller> {
    const payload = await this.verifyFor(token, INTERNAL_AUDIENCE);
    if (payload.typ !== 'service' || typeof payload.sub !== 'string' || !payload.sub.startsWith('svc:')) {
      throw new Error('Not a service token');
    }
    return { service: payload.sub.slice(4) };
  }

  private async verifyFor(token: string, audience: string) {
    this.key ??= importSPKI(this.options.publicKeyPem, 'RS256');
    const { payload } = await jwtVerify(token, await this.key, {
      issuer: this.options.issuer,
      audience,
      algorithms: ['RS256'],
    });
    return payload;
  }
}
