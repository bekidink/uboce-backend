import { generateKeyPairSync } from 'node:crypto';

import { AccessTokenVerifier } from '@uboce/common';
import { describe, expect, it } from 'vitest';

import { TokenSigner } from './token-signer.js';

const keys = () =>
  generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

describe('TokenSigner', () => {
  const { publicKey, privateKey } = keys();
  const signer = new TokenSigner({
    privateKeyPem: privateKey,
    publicKeyPem: publicKey,
    issuer: 'uboce-identity',
    audience: 'uboce',
    accessTtlSeconds: 900,
    serviceTtlSeconds: 300,
  });
  const verifier = new AccessTokenVerifier({ publicKeyPem: publicKey, issuer: 'uboce-identity', audience: 'uboce' });

  it('access tokens pass the shared verifier', async () => {
    await expect(verifier.verify(await signer.signAccess('user-1', 'session-1'))).resolves.toEqual({
      userId: 'user-1',
      sessionId: 'session-1',
    });
  });

  it('access tokens are rejected for another audience or key', async () => {
    const token = await signer.signAccess('user-1', 'session-1');
    const otherAudience = new AccessTokenVerifier({ publicKeyPem: publicKey, issuer: 'uboce-identity', audience: 'x' });
    const otherKey = new AccessTokenVerifier({ publicKeyPem: keys().publicKey, issuer: 'uboce-identity', audience: 'uboce' });
    await expect(otherAudience.verify(token)).rejects.toThrow();
    await expect(otherKey.verify(token)).rejects.toThrow();
  });

  it('service tokens only work as service tokens', async () => {
    const serviceToken = await signer.signService('procurement');
    await expect(verifier.verifyService(serviceToken)).resolves.toEqual({ service: 'procurement' });
    await expect(verifier.verify(serviceToken)).rejects.toThrow();
    await expect(verifier.verifyService(await signer.signAccess('user-1', 's'))).rejects.toThrow();
  });

  it('MFA challenges are neither access nor service tokens', async () => {
    const challenge = await signer.signMfaChallenge('user-1');
    await expect(signer.verifyMfaChallenge(challenge)).resolves.toMatchObject({ userId: 'user-1' });
    await expect(verifier.verify(challenge)).rejects.toThrow();
    await expect(verifier.verifyService(challenge)).rejects.toThrow();
    await expect(signer.verifyMfaChallenge(await signer.signAccess('user-1', 's'))).rejects.toThrow();
  });
});
