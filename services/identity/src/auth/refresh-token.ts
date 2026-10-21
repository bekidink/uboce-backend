import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Refresh tokens are `<sessionId>.<secret>`: the ID finds the session row, the
// 256-bit secret proves possession. Only a SHA-256 of the secret is stored, so
// a database leak doesn't hand out usable tokens.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const newRefreshSecret = () => randomBytes(32).toString('base64url');

export const hashSecret = (secret: string) => createHash('sha256').update(secret).digest('hex');

export const formatRefreshToken = (sessionId: string, secret: string) => `${sessionId}.${secret}`;

export function parseRefreshToken(token: string): { sessionId: string; secret: string } | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [sessionId, secret] = parts as [string, string];
  if (!UUID.test(sessionId) || secret.length < 32) return null;
  return { sessionId, secret };
}

export function secretMatches(secret: string, storedHash: string): boolean {
  const a = Buffer.from(hashSecret(secret), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
