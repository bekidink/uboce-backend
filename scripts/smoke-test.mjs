// End-to-end smoke test against running services (PRD 12.2 scenarios for Stage 1).
// Usage: pnpm smoke   (services must be running: pnpm dev, or node dist/main.js)
import { randomUUID } from 'node:crypto';

const IDENTITY = process.env.IDENTITY_URL ?? 'http://localhost:4101/api/v1';
const ORGANIZATION = process.env.ORGANIZATION_URL ?? 'http://localhost:4102/api/v1';
const NOTIFICATION = process.env.NOTIFICATION_URL ?? 'http://localhost:4103/api/v1';

let failures = 0;
const check = (name, condition, detail) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition || detail === undefined ? '' : `  → ${JSON.stringify(detail)}`}`);
  if (!condition) failures++;
};

async function call(method, url, { token, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-correlation-id': `smoke-${randomUUID()}`,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const waitFor = async (fn, timeoutMs = 10_000) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
};

const newUser = (name, locale = 'en') => ({
  email: `${name}-${randomUUID().slice(0, 8)}@example.com`,
  password: 'correct horse battery',
  displayName: name,
  locale,
});

// --- Identity ---------------------------------------------------------------
const alice = newUser('Alice');
const bob = newUser('Bob', 'am');

let r = await call('POST', `${IDENTITY}/auth/register`, { body: alice });
check('register returns tokens', r.status === 201 && r.body.accessToken && r.body.refreshToken, r);
let aliceTokens = r.body;

r = await call('POST', `${IDENTITY}/auth/register`, { body: alice });
check('duplicate email is rejected', r.status === 409 && r.body.error.code === 'account_exists', r);

r = await call('POST', `${IDENTITY}/auth/register`, { body: { ...newUser('x'), email: 'not-an-email' } });
check('validation errors use the shared error shape', r.status === 400 && r.body.error.code === 'validation_failed' && r.body.correlationId, r);

r = await call('POST', `${IDENTITY}/auth/register`, { body: bob });
const bobTokens = r.body;

r = await call('GET', `${IDENTITY}/auth/me`, { token: aliceTokens.accessToken });
check('me returns the profile without the password hash', r.status === 200 && r.body.email === alice.email.toLowerCase() && !('passwordHash' in r.body), r);
const aliceId = r.body.id;
const bobId = (await call('GET', `${IDENTITY}/auth/me`, { token: bobTokens.accessToken })).body.id;

r = await call('POST', `${IDENTITY}/auth/login`, { body: { email: alice.email, password: 'wrong password!!' } });
check('wrong password is rejected', r.status === 401 && r.body.error.code === 'invalid_credentials', r);

r = await call('GET', `${ORGANIZATION}/organizations`);
check('requests without a token are rejected', r.status === 401, r);

// --- Organization & tenant isolation ----------------------------------------
r = await call('POST', `${ORGANIZATION}/organizations`, {
  token: aliceTokens.accessToken,
  body: { name: 'Abebe Coffee Cooperative', type: 'cooperative' },
});
check('create organization', r.status === 201 && r.body.countryCode === 'ET', r);
const orgId = r.body.id;

r = await call('GET', `${ORGANIZATION}/organizations/${orgId}`, { token: bobTokens.accessToken });
check('non-member gets 404, not 403 (no ID probing)', r.status === 404, r);

r = await call('POST', `${ORGANIZATION}/organizations/${orgId}/members`, {
  token: aliceTokens.accessToken,
  body: { userId: bobId, role: 'procurement_officer' },
});
check('owner adds a member', r.status === 201 && r.body.role === 'procurement_officer', r);
const bobMembershipId = r.body.id;

r = await call('GET', `${ORGANIZATION}/organizations/${orgId}/access`, { token: bobTokens.accessToken });
check('member sees their limited permissions', r.status === 200 && !r.body.permissions.includes('members:manage'), r);

r = await call('PATCH', `${ORGANIZATION}/organizations/${orgId}`, { token: bobTokens.accessToken, body: { name: 'Hijacked' } });
check('procurement officer cannot edit the organization', r.status === 403, r);

r = await call('POST', `${ORGANIZATION}/organizations/${orgId}/members`, {
  token: bobTokens.accessToken,
  body: { userId: randomUUID(), role: 'owner' },
});
check('procurement officer cannot add members', r.status === 403, r);

const aliceMembership = (await call('GET', `${ORGANIZATION}/organizations/${orgId}/members`, { token: aliceTokens.accessToken })).body.items.find(
  (m) => m.userId === aliceId,
);
r = await call('DELETE', `${ORGANIZATION}/organizations/${orgId}/members/${aliceMembership.id}`, { token: aliceTokens.accessToken });
check('last owner cannot leave', r.status === 409 && r.body.error.code === 'last_owner', r);

// --- Events → notifications --------------------------------------------------
const bobInbox = await waitFor(async () => {
  const res = await call('GET', `${NOTIFICATION}/notifications`, { token: bobTokens.accessToken });
  return res.body?.items?.length >= 2 ? res.body.items : null;
});
check('member is notified via events (welcome + added)', bobInbox?.some((n) => n.templateKey === 'membership_added'), bobInbox);
check('notifications use the user locale (am)', bobInbox?.every((n) => /[ሀ-፿]/.test(n.title)), bobInbox?.map((n) => n.title));

const aliceInbox = await waitFor(async () => {
  const res = await call('GET', `${NOTIFICATION}/notifications`, { token: aliceTokens.accessToken });
  return res.body?.items?.some((n) => n.templateKey === 'organization_created') ? res.body.items : null;
});
check('creator is notified of the new organization', !!aliceInbox, aliceInbox);

r = await call('POST', `${NOTIFICATION}/notifications/devices`, {
  token: bobTokens.accessToken,
  body: { token: `fcm-test-token-${randomUUID()}`, platform: 'android' },
});
check('register a push device', r.status === 204, r);

r = await call('DELETE', `${ORGANIZATION}/organizations/${orgId}/members/${bobMembershipId}`, { token: aliceTokens.accessToken });
check('owner removes a member', r.status === 204, r);
r = await call('GET', `${ORGANIZATION}/organizations/${orgId}`, { token: bobTokens.accessToken });
check('removed member loses access immediately', r.status === 404, r);

// --- Refresh rotation & reuse detection ---------------------------------------
r = await call('POST', `${IDENTITY}/auth/refresh`, { body: { refreshToken: aliceTokens.refreshToken } });
check('refresh rotates the token', r.status === 200 && r.body.refreshToken !== aliceTokens.refreshToken, r);
const rotated = r.body;

r = await call('POST', `${IDENTITY}/auth/refresh`, { body: { refreshToken: aliceTokens.refreshToken } });
check('reusing an old refresh token is rejected', r.status === 401, r);

r = await call('POST', `${IDENTITY}/auth/refresh`, { body: { refreshToken: rotated.refreshToken } });
check('…and revokes the whole session family', r.status === 401, r);

r = await call('GET', `${ORGANIZATION}/organizations`, { token: rotated.accessToken });
check('…including live access tokens, in other services too', r.status === 401, r);

// --- Logout ---------------------------------------------------------------
r = await call('POST', `${IDENTITY}/auth/logout`, { token: bobTokens.accessToken });
check('logout', r.status === 204, r);
r = await call('GET', `${NOTIFICATION}/notifications`, { token: bobTokens.accessToken });
check('access token stops working after logout', r.status === 401, r);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
