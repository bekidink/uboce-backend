import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { formatRefreshToken, hashSecret, newRefreshSecret, parseRefreshToken, secretMatches } from './refresh-token.js';

describe('refresh tokens', () => {
  it('round-trips a formatted token', () => {
    const sessionId = randomUUID();
    const secret = newRefreshSecret();
    expect(parseRefreshToken(formatRefreshToken(sessionId, secret))).toEqual({ sessionId, secret });
  });

  it('rejects malformed tokens', () => {
    expect(parseRefreshToken('not-a-token')).toBeNull();
    expect(parseRefreshToken(`${randomUUID()}.short`)).toBeNull();
    expect(parseRefreshToken(`nope.${newRefreshSecret()}`)).toBeNull();
    expect(parseRefreshToken(`${randomUUID()}.${newRefreshSecret()}.extra`)).toBeNull();
  });

  it('matches only the original secret', () => {
    const secret = newRefreshSecret();
    const stored = hashSecret(secret);
    expect(secretMatches(secret, stored)).toBe(true);
    expect(secretMatches(newRefreshSecret(), stored)).toBe(false);
    expect(secretMatches(secret, 'abcd')).toBe(false);
  });
});
