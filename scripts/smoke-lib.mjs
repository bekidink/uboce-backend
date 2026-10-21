// Shared helpers for the end-to-end smoke tests.
import { createHmac, randomUUID } from 'node:crypto';

export const API = process.env.API_URL ?? 'http://localhost:4100/api/v1';
export const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
export const PASSWORD = 'correct horse battery';

let failures = 0;
let checks = 0;
export const check = (name, condition, detail) => {
  checks++;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition || detail === undefined ? '' : `  → ${JSON.stringify(detail).slice(0, 700)}`}`);
  if (!condition) failures++;
};
export const heading = (title) => console.log(`\n— ${title}`);
export const finish = () => {
  console.log(failures === 0 ? `\nAll ${checks} checks passed.` : `\n${failures} of ${checks} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
};

export async function call(method, path, { token, org, body, headers = {} } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-correlation-id': `smoke-${randomUUID()}`,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(org ? { 'x-organization-id': org } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

export const waitFor = async (fn, timeoutMs = 20_000) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
};

export const waitForEmail = (address, subjectPattern) =>
  waitFor(async () => {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`);
    const list = await res.json();
    const hit = list.messages?.find((m) => subjectPattern.test(m.Subject));
    return hit ? (await fetch(`${MAILPIT}/api/v1/message/${hit.ID}`)).json() : null;
  });
export const tokenFrom = (email) => email?.Text?.match(/token=([A-Za-z0-9_-]+)/)?.[1];

// RFC 6238, as an authenticator app computes it.
const base32Decode = (s) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out = [];
  for (const c of s) {
    value = (value << 5) | alphabet.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
};
export const totp = (secret, offsetSteps = 0) => {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offsetSteps));
  const h = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
};

export const newUser = (name, locale = 'en') => ({
  email: `${name.toLowerCase()}-${randomUUID().slice(0, 8)}@example.com`,
  password: PASSWORD,
  displayName: name,
  locale,
});

export const register = async (user) => {
  const r = await call('POST', '/auth/register', { body: user });
  const me = await call('GET', '/auth/me', { token: r.body.accessToken });
  return { ...user, ...r.body, id: me.body.id, token: r.body.accessToken };
};

export const verifyEmail = async (user) => {
  const mail = await waitForEmail(user.email, /Confirm your email|ኢሜይል/);
  return call('POST', '/auth/email/verify', { body: { token: tokenFrom(mail) } });
};

export const inDays = (d) => new Date(Date.now() + d * 86_400_000).toISOString();

/** Webhook signature, exactly as a provider would compute it. */
export const signCallback = (secret, rawBody, timestamp = Math.floor(Date.now() / 1000)) => ({
  'x-uboce-timestamp': String(timestamp),
  'x-uboce-signature': `sha256=${createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex')}`,
});

/** Uploads bytes through the Document service's signed-URL flow. */
export async function upload(user, org, { classification, fileName, contentType, bytes }) {
  const created = await call('POST', '/documents', { token: user.token, org, body: { classification, fileName, contentType, sizeBytes: bytes.length } });
  if (created.status !== 201) return created;
  const put = await fetch(created.body.upload.url, { method: 'PUT', headers: created.body.upload.headers, body: bytes });
  if (!put.ok) return { status: put.status, body: await put.text() };
  return call('POST', `/documents/${created.body.document.id}/complete`, { token: user.token, org });
}

export const PDF = (label) => Buffer.from(`%PDF-1.4\n% ${label}\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`);
export const PNG = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
