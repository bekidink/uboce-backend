import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { SecretBox } from './secret-box.js';
import { base32Decode, base32Encode, hotp, totp, verifyTotp } from './totp.js';

// RFC 4226 Appendix D / RFC 6238 Appendix B test secret ("12345678901234567890").
const RFC_SECRET = Buffer.from('12345678901234567890');
const RFC_SECRET_B32 = base32Encode(RFC_SECRET);

describe('TOTP', () => {
  it('matches the RFC 4226 HOTP test vectors', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314'];
    expected.forEach((code, counter) => expect(hotp(RFC_SECRET, counter)).toBe(code));
  });

  it('matches the RFC 6238 TOTP test vectors (SHA-1, 6 digits)', () => {
    expect(totp(RFC_SECRET_B32, 59_000)).toBe('287082');
    expect(totp(RFC_SECRET_B32, 1_111_111_109_000)).toBe('081804');
    expect(totp(RFC_SECRET_B32, 1_234_567_890_000)).toBe('005924');
  });

  it('accepts one step of clock drift and nothing more', () => {
    const now = 1_700_000_000_000;
    expect(verifyTotp(RFC_SECRET_B32, totp(RFC_SECRET_B32, now - 30_000), now)).not.toBeNull();
    expect(verifyTotp(RFC_SECRET_B32, totp(RFC_SECRET_B32, now + 30_000), now)).not.toBeNull();
    expect(verifyTotp(RFC_SECRET_B32, totp(RFC_SECRET_B32, now - 90_000), now)).toBeNull();
    expect(verifyTotp(RFC_SECRET_B32, 'abcdef', now)).toBeNull();
  });

  it('round-trips base32', () => {
    const bytes = randomBytes(20);
    expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
  });
});

describe('SecretBox', () => {
  const box = new SecretBox(randomBytes(32).toString('base64'));

  it('round-trips and never repeats ciphertext', () => {
    const a = box.seal('JBSWY3DPEHPK3PXP');
    expect(box.open(a)).toBe('JBSWY3DPEHPK3PXP');
    expect(box.seal('JBSWY3DPEHPK3PXP')).not.toBe(a);
  });

  it('detects tampering', () => {
    const [iv, tag, data] = box.seal('secret').split('.');
    const flipped = Buffer.from(data!, 'base64url');
    flipped[0]! ^= 1;
    expect(() => box.open([iv, tag, flipped.toString('base64url')].join('.'))).toThrow();
  });
});
