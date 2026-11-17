// Phone numbers (PRD v2 ORG-01, NTF-02). Stored and sent in E.164 (+2519…).
// Ethiopian local forms are accepted: 09…/07… (10 digits) and 9…/7… (9 digits).

/** E.164, or null when the input can't be a phone number. */
export function normalizePhone(input: string, defaultCountry = '251'): string | null {
  const raw = input.trim().replace(/[\s().-]/g, '');
  if (!raw) return null;
  let digits: string;
  if (raw.startsWith('+')) digits = raw.slice(1);
  else if (raw.startsWith('00')) digits = raw.slice(2);
  else if (defaultCountry === '251' && /^0[79]\d{8}$/.test(raw)) digits = `251${raw.slice(1)}`;
  else if (defaultCountry === '251' && /^[79]\d{8}$/.test(raw)) digits = `251${raw}`;
  else if (raw.startsWith(defaultCountry)) digits = raw;
  else return null;
  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  // Ethiopian mobile numbers: +251 then 9 or 7 and eight more digits.
  if (digits.startsWith('251') && !/^251[79]\d{8}$/.test(digits)) return null;
  return `+${digits}`;
}

/** For logs and screens: +2519****12. */
export const maskPhone = (e164: string) => `${e164.slice(0, 5)}****${e164.slice(-2)}`;

/**
 * Bot protection (PLT-09): verifies a Cloudflare Turnstile token when
 * TURNSTILE_SECRET_KEY is set; otherwise every request passes, so local
 * development and tests need nothing. Fails closed on a provider error.
 */
export async function verifyHuman(token: string | undefined, ip?: string): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true;
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret, response: token, ...(ip ? { remoteip: ip } : {}) });
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body, signal: AbortSignal.timeout(5000) });
    const out = (await res.json()) as { success?: boolean };
    return out.success === true;
  } catch {
    return false;
  }
}
