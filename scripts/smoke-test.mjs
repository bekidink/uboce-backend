// End-to-end smoke test through the API gateway (PRD 12.2 scenarios for Stages 1–2).
// Needs the infrastructure (`pnpm infra:up`, incl. Mailpit) and every service + gateway running.
//   pnpm smoke
import { createHmac, randomUUID } from 'node:crypto';

const API = process.env.API_URL ?? 'http://localhost:4100/api/v1';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';

let failures = 0;
let section = '';
const check = (name, condition, detail) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition || detail === undefined ? '' : `  → ${JSON.stringify(detail).slice(0, 600)}`}`);
  if (!condition) failures++;
};
const heading = (title) => {
  section = title;
  console.log(`\n— ${title}`);
};

async function call(method, path, { token, org, body, headers = {} } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-correlation-id': `smoke-${randomUUID()}`,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(org ? { 'x-organization-id': org } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
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

const waitFor = async (fn, timeoutMs = 15_000) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
};

/** Latest email to `address` whose subject matches, from Mailpit. */
const waitForEmail = (address, subjectPattern) =>
  waitFor(async () => {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`);
    const list = await res.json();
    const hit = list.messages?.find((m) => subjectPattern.test(m.Subject));
    if (!hit) return null;
    return (await fetch(`${MAILPIT}/api/v1/message/${hit.ID}`)).json();
  });
const tokenFrom = (email) => email?.Text?.match(/token=([A-Za-z0-9_-]+)/)?.[1];

// RFC 6238, as an authenticator app computes it.
const base32Decode = (s) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const out = [];
  for (const c of s) {
    value = (value << 5) | alphabet.indexOf(c);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
};
const totp = (secret, offsetSteps = 0) => {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offsetSteps));
  const h = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
};

const PASSWORD = 'correct horse battery';
const newUser = (name, locale = 'en') => ({
  email: `${name.toLowerCase()}-${randomUUID().slice(0, 8)}@example.com`,
  password: PASSWORD,
  displayName: name,
  locale,
});
const register = async (user) => {
  const r = await call('POST', '/auth/register', { body: user });
  const me = await call('GET', '/auth/me', { token: r.body.accessToken });
  return { ...user, ...r.body, id: me.body.id, token: r.body.accessToken };
};
const inDays = (d) => new Date(Date.now() + d * 86_400_000).toISOString();

// =============================================================================
heading('Gateway');
let r = await fetch(API.replace('/api/v1', '/health/ready')).then((x) => x.json());
check('every service is ready behind the gateway', r.status === 'ok', r);
for (const path of ['/internal/token', '/INTERNAL/token', '/%69nternal/token', '/auth/..%2Finternal%2Ftoken', '/organizations/x/../../internal/organizations/x']) {
  r = await call('POST', path, { body: { clientId: 'identity', clientSecret: 'x'.repeat(40) } });
  check(`internal route is unreachable: ${path}`, r.status === 404, r);
}
r = await call('GET', '/nope');
check('unknown routes are 404 in the shared error shape', r.status === 404 && r.body.error?.code === 'not_found', r);
const correlationId = `smoke-trace-${randomUUID()}`;
r = await call('GET', '/discovery/status', { headers: { 'x-correlation-id': correlationId } });
check('correlation ID is echoed end to end', r.headers.get('x-correlation-id') === correlationId, [...r.headers]);

// =============================================================================
heading('Identity: registration, verification, passwords');
const alice = await register(newUser('Alice'));
const bob = await register(newUser('Bob', 'am'));
const carol = await register(newUser('Carol'));
const dave = await register(newUser('Dave'));
check('register returns tokens', !!alice.accessToken && !!alice.refreshToken, alice);

r = await call('POST', '/auth/register', { body: { email: alice.email, password: PASSWORD, displayName: 'x' } });
check('duplicate email is rejected', r.status === 409 && r.body.error.code === 'account_exists', r);
r = await call('POST', '/auth/register', { body: { ...newUser('x'), email: 'not-an-email' } });
check('validation errors use the shared error shape', r.status === 400 && r.body.error.code === 'validation_failed' && !!r.body.correlationId, r);
r = await call('POST', '/auth/login', { body: { email: alice.email, password: 'wrong password!!' } });
check('wrong password is rejected', r.status === 401 && r.body.error.code === 'invalid_credentials', r);
r = await call('GET', '/organizations');
check('requests without a token are rejected', r.status === 401, r);

const verifyMail = await waitForEmail(alice.email, /Confirm your email/);
check('verification email arrives (Mailpit)', !!tokenFrom(verifyMail), verifyMail?.Subject);
r = await call('POST', '/auth/email/verify', { body: { token: tokenFrom(verifyMail) } });
check('email verification link works', r.status === 204, r);
r = await call('GET', '/auth/me', { token: alice.token });
check('profile shows the email as verified', r.body.emailVerified === true, r.body);
r = await call('POST', '/auth/email/verify', { body: { token: tokenFrom(verifyMail) } });
check('verification links are single-use', r.status === 400 && r.body.error.code === 'invalid_token', r);
const bobMail = await waitForEmail(bob.email, /ኢሜይል/);
check('emails use the recipient language (am)', !!bobMail, bobMail?.Subject);

r = await call('POST', '/auth/password/forgot', { body: { email: `nobody-${randomUUID()}@example.com` } });
check('password reset never reveals whether an email exists', r.status === 202, r);
r = await call('POST', '/auth/password/forgot', { body: { email: carol.email } });
const resetMail = await waitForEmail(carol.email, /Reset your password/);
check('reset email arrives', r.status === 202 && !!tokenFrom(resetMail), resetMail?.Subject);
r = await call('POST', '/auth/password/reset', { body: { token: tokenFrom(resetMail), newPassword: 'a brand new passphrase' } });
check('password reset succeeds', r.status === 204, r);
r = await call('POST', '/auth/refresh', { body: { refreshToken: carol.refreshToken } });
check('…and signs out existing sessions', r.status === 401, r);
r = await call('POST', '/auth/login', { body: { email: carol.email, password: PASSWORD } });
check('…the old password no longer works', r.status === 401, r);
r = await call('POST', '/auth/login', { body: { email: carol.email, password: 'a brand new passphrase' } });
check('…the new one does', r.status === 200 && !!r.body.accessToken, r);
carol.token = r.body.accessToken;

// =============================================================================
heading('Identity: two-factor sign-in (TOTP)');
r = await call('POST', '/auth/mfa/setup', { token: dave.token });
const secret = r.body.secret;
check('MFA setup returns a secret and otpauth URL', !!secret && r.body.otpauthUrl?.startsWith('otpauth://totp/'), r.body);
r = await call('POST', '/auth/mfa/enable', { token: dave.token, body: { code: '000000' === totp(secret) ? '111111' : '000000' } });
check('a wrong code does not enable MFA', r.status === 400, r);
r = await call('POST', '/auth/mfa/enable', { token: dave.token, body: { code: totp(secret) } });
const recoveryCodes = r.body.recoveryCodes;
check('MFA enables and returns 10 recovery codes', r.status === 201 && recoveryCodes?.length === 10, r);

r = await call('POST', '/auth/login', { body: { email: dave.email, password: PASSWORD } });
check('password login now asks for a second factor', r.body.mfaRequired === true && !!r.body.mfaToken && !r.body.accessToken, r.body);
let mfaToken = r.body.mfaToken;
r = await call('POST', '/auth/mfa/verify', { body: { mfaToken, code: totp(secret, 5) } });
check('a code from the wrong time window is rejected', r.status === 401, r);
r = await call('POST', '/auth/mfa/verify', { body: { mfaToken, code: totp(secret) } });
check('the right code completes sign-in', r.status === 200 && !!r.body.accessToken, r);
dave.token = r.body.accessToken;
r = await call('POST', '/auth/mfa/verify', { body: { mfaToken, code: totp(secret) } });
check('an MFA challenge cannot be used twice', r.status === 401, r);
r = await call('POST', '/auth/login', { body: { email: dave.email, password: PASSWORD } });
mfaToken = r.body.mfaToken;
r = await call('POST', '/auth/mfa/verify', { body: { mfaToken, recoveryCode: recoveryCodes[0] } });
check('a recovery code signs in', r.status === 200 && !!r.body.accessToken, r);
r = await call('POST', '/auth/login', { body: { email: dave.email, password: PASSWORD } });
r = await call('POST', '/auth/mfa/verify', { body: { mfaToken: r.body.mfaToken, recoveryCode: recoveryCodes[0] } });
check('…but only once', r.status === 401, r);

// =============================================================================
heading('Organizations, invitations, tenant isolation');
const createOrg = async (user, name, type) =>
  (await call('POST', '/organizations', { token: user.token, body: { name, type } })).body;
const buyer = await createOrg(alice, 'Addis Roasters', 'business');
const supplier = await createOrg(bob, 'Sidama Coffee Farmers Union', 'cooperative');
const otherSupplier = await createOrg(carol, 'Guji Exporters', 'wholesaler');
check('organizations are created', !!buyer.id && !!supplier.id && !!otherSupplier.id, { buyer, supplier });

r = await call('GET', `/organizations/${buyer.id}`, { token: bob.token });
check('non-members get 404 (no ID probing)', r.status === 404, r);

r = await call('POST', `/organizations/${buyer.id}/invitations`, { token: alice.token, body: { email: dave.email, role: 'procurement_officer' } });
check('owner invites by email', r.status === 201 && !('tokenHash' in r.body), r);
const invitation = await waitForEmail(dave.email, /Join Addis Roasters/);
check('invitation email arrives', !!tokenFrom(invitation), invitation?.Subject);
r = await call('POST', `/organizations/${buyer.id}/invitations`, { token: alice.token, body: { email: `stranger-${randomUUID()}@example.com`, role: 'auditor' } });
const strangerInvite = await waitForEmail(r.body.email, /Join Addis Roasters/);
r = await call('POST', '/invitations/accept', { token: dave.token, body: { token: tokenFrom(strangerInvite) } });
check("an invitation for someone else's email cannot be accepted", r.status === 403 && r.body.error.code === 'invitation_mismatch', r);
r = await call('POST', '/invitations/accept', { token: dave.token, body: { token: tokenFrom(invitation) } });
check('the invitee accepts and becomes a member', r.status === 201 && r.body.membership?.role === 'procurement_officer', r);
r = await call('POST', '/invitations/accept', { token: dave.token, body: { token: tokenFrom(invitation) } });
check('an invitation works only once', r.status === 400, r);
r = await call('GET', `/organizations/${buyer.id}/access`, { token: dave.token });
check('the new member has limited permissions', r.status === 200 && !r.body.permissions.includes('members:manage'), r.body);
r = await call('PATCH', `/organizations/${buyer.id}`, { token: dave.token, body: { name: 'Hijacked' } });
check('a procurement officer cannot edit the organization', r.status === 403, r);

r = await call('GET', '/catalog/products', { token: bob.token, org: buyer.id });
check("acting for an organization you don't belong to is refused", r.status === 404, r);
r = await call('GET', '/catalog/products', { token: bob.token });
check('organization-scoped routes require x-organization-id', r.status === 400 && r.body.error.code === 'organization_required', r);

// =============================================================================
heading('Catalog & Discovery');
r = await call('GET', '/catalog/categories');
const coffee = r.body.find((c) => c.slug === 'coffee');
check('categories are public and define required attributes', coffee?.requiredAttributes?.includes('process'), coffee);

r = await call('POST', '/catalog/products', {
  token: bob.token,
  org: supplier.id,
  body: {
    name: 'Sidama Grade 1 Washed Coffee',
    description: 'Specialty-grade green coffee from smallholder farmers',
    categoryId: coffee.id,
    unitOfMeasure: 'quintal',
    attributes: { origin: 'Sidama', grade: '1' },
    variants: [{ sku: `SID-G1-${randomUUID().slice(0, 6)}`, name: '60 kg bag', price: '18500.00', currency: 'ETB' }],
  },
});
const product = r.body;
check('a draft product is created', r.status === 201 && product.status === 'draft', r);
r = await call('POST', `/catalog/products/${product.id}/publish`, { token: bob.token, org: supplier.id });
check('publishing is blocked until required attributes are filled', r.status === 422 && r.body.error.details?.[0]?.includes('process'), r);
await call('PATCH', `/catalog/products/${product.id}`, { token: bob.token, org: supplier.id, body: { attributes: { origin: 'Sidama', grade: '1', process: 'washed' } } });
r = await call('POST', `/catalog/products/${product.id}/publish`, { token: bob.token, org: supplier.id });
check('a complete product publishes', r.status === 201 && r.body.status === 'published', r);
r = await call('GET', `/catalog/products/${product.id}`, { token: alice.token, org: buyer.id });
check("another organization can't manage the product", r.status === 404, r);
r = await call('GET', `/catalog/published/${product.id}`, { token: alice.token });
check('…but any signed-in user can view it once published', r.status === 200 && r.body.variants.length === 1, r);

const hit = await waitFor(async () => {
  const res = await call('GET', '/discovery/products?q=sidam%20washed');
  return res.body.items?.find((p) => p.productId === product.id);
});
check('the product becomes searchable (prefix, multi-word, no token)', hit?.supplier?.name === supplier.name, hit);
r = await call('GET', '/discovery/products?category=coffee&maxPrice=1000');
check('price filters apply', !r.body.items.some((p) => p.productId === product.id), r.body.meta);
r = await call('GET', '/discovery/suppliers?q=sidama');
check('supplier discovery lists organizations with live products', r.body.items.some((s) => s.organizationId === supplier.id), r.body);
r = await call('GET', '/discovery/status');
check('index freshness is reported', r.body.listings >= 1 && r.body.lastIndexedAt, r.body);

r = await call('POST', '/catalog/products', {
  token: bob.token,
  org: supplier.id,
  body: { name: 'Short-lived teff listing', categoryId: r.body && (await call('GET', '/catalog/categories')).body.find((c) => c.slug === 'general').id, unitOfMeasure: 'kg', variants: [{ sku: `TMP-${randomUUID().slice(0, 6)}`, name: 'kg', price: '90', currency: 'ETB' }] },
});
const temp = r.body;
await call('POST', `/catalog/products/${temp.id}/publish`, { token: bob.token, org: supplier.id });
await waitFor(async () => (await call('GET', '/discovery/products?q=short%20lived')).body.items?.length > 0);
await call('POST', `/catalog/products/${temp.id}/archive`, { token: bob.token, org: supplier.id });
const gone = await waitFor(async () => (await call('GET', '/discovery/products?q=short%20lived')).body.items?.length === 0);
check('archived products disappear from search', !!gone);

// =============================================================================
heading('Procurement: RFQ → quotations → award');
r = await call('POST', '/rfqs', {
  token: alice.token,
  org: buyer.id,
  body: {
    title: 'Green coffee for Q1 roasting',
    currency: 'ETB',
    deliveryTerms: 'DAP Addis Ababa',
    deliveryLocation: 'Bole, Addis Ababa',
    responseDeadline: inDays(7),
    visibility: 'invited',
    invitedSupplierOrganizationIds: [supplier.id],
    lines: [
      { productId: product.id, description: 'Sidama Grade 1 washed', quantity: '50', unitOfMeasure: 'quintal' },
      { description: 'Jute bags', quantity: '100', unitOfMeasure: 'piece' },
    ],
  },
});
const rfq = r.body;
check('the buyer drafts an invited RFQ', r.status === 201 && rfq.status === 'draft' && rfq.lines.length === 2, r);
r = await call('POST', `/rfqs/${rfq.id}/publish`, { token: alice.token, org: buyer.id });
check('…and publishes it', r.body.status === 'published', r);

r = await call('GET', '/rfqs/open', { token: bob.token, org: supplier.id });
check('the invited supplier sees it among open RFQs', r.body.items.some((x) => x.id === rfq.id), r.body.meta);
r = await call('GET', `/rfqs/${rfq.id}`, { token: bob.token, org: supplier.id });
check('suppliers never see who else was invited', r.status === 200 && !('invitations' in r.body), r.body);
r = await call('GET', `/rfqs/${rfq.id}`, { token: carol.token, org: otherSupplier.id });
check('a supplier that was not invited cannot see it', r.status === 404, r);

const quote = (price1, price2) => ({
  validUntil: inDays(14),
  lines: [
    { rfqLineId: rfq.lines[0].id, unitPrice: price1, leadTimeDays: 10 },
    { rfqLineId: rfq.lines[1].id, unitPrice: price2 },
  ],
});
r = await call('POST', `/rfqs/${rfq.id}/quotations`, { token: carol.token, org: otherSupplier.id, body: quote('1', '1') });
check('…nor quote on it', r.status === 404, r);
r = await call('POST', `/rfqs/${rfq.id}/quotations`, { token: bob.token, org: supplier.id, body: quote('19000.00', '45.50') });
check('the supplier quotes, totalled with exact decimals', r.status === 201 && r.body.total === '954550' && r.body.revision === 1, r.body);
r = await call('POST', `/rfqs/${rfq.id}/quotations`, { token: bob.token, org: supplier.id, body: quote('18200.00', '45.50') });
const quotation = r.body;
check('revising bumps the revision', quotation.revision === 2 && quotation.total === '914550', quotation);
r = await call('GET', `/quotations/${quotation.id}`, { token: bob.token, org: supplier.id });
check('…and keeps the earlier revision in history', r.body.revisions?.length === 1 && r.body.revisions[0].revision === 1, r.body.revisions);
r = await call('GET', `/rfqs/${rfq.id}/quotations`, { token: alice.token, org: buyer.id });
check('the buyer compares quotations', r.status === 200 && r.body.length === 1, r);
r = await call('GET', `/rfqs/${rfq.id}/quotations`, { token: bob.token, org: supplier.id });
check("a supplier can't open the buyer's comparison", r.status === 404 || r.status === 403, r);

r = await call('POST', `/rfqs/${rfq.id}/quotations/${quotation.id}/accept`, { token: dave.token, org: buyer.id });
check("the buyer's procurement officer accepts the quotation", r.status === 201 && r.body.quotation.status === 'accepted', r);
r = await call('POST', `/rfqs/${rfq.id}/quotations/${quotation.id}/accept`, { token: alice.token, org: buyer.id });
check('accepting again is refused', r.status === 409 && r.body.error.code === 'already_awarded', r);

// =============================================================================
heading('Commerce: orders');
const orders = await waitFor(async () => {
  const res = await call('GET', `/purchase-orders?quotationId=${quotation.id}`, { token: alice.token, org: buyer.id });
  return res.body.items?.length ? res.body : null;
});
const order = orders?.items?.[0];
check('exactly one purchase order is created from the accepted quotation', orders?.meta.total === 1 && order?.total === '914550', orders);
check('…with an immutable commercial snapshot and a PO number', order?.lines?.length === 2 && /^PO-\d{4}-\d{6}$/.test(order?.number), order);
r = await call('GET', `/sales-orders/${order.id}`, { token: bob.token, org: supplier.id });
check('the supplier sees it as a sales order', r.status === 200 && r.body.status === 'pending_confirmation', r);
r = await call('GET', `/sales-orders/${order.id}`, { token: carol.token, org: otherSupplier.id });
check('no one else can see it', r.status === 404, r);
r = await call('POST', `/purchase-orders/${order.id}/cancel`, { token: carol.token, org: otherSupplier.id, body: {} });
check('…or act on it', r.status === 404, r);

r = await call('POST', `/sales-orders/${order.id}/confirm`, { token: bob.token, org: supplier.id });
check('the supplier confirms', r.body.status === 'confirmed' && r.body.history.length === 2, r);
r = await call('POST', `/sales-orders/${order.id}/cancel`, { token: bob.token, org: supplier.id, body: { reason: 'changed mind' } });
check('a supplier cannot cancel a confirmed order (state machine)', r.status === 409 && r.body.error.code === 'invalid_transition', r);

const directOrder = (qty) => ({
  supplierOrganizationId: otherSupplier.id,
  currency: 'ETB',
  title: 'Sample lot',
  lines: [{ description: 'Guji natural sample', quantity: qty, unitOfMeasure: 'kg', unitPrice: '950.00' }],
});
const key = `order-${randomUUID()}`;
r = await call('POST', '/purchase-orders', { token: alice.token, org: buyer.id, body: directOrder('20') });
check('direct orders require an Idempotency-Key', r.status === 400 && r.body.error.code === 'idempotency_key_required', r);
r = await call('POST', '/purchase-orders', { token: alice.token, org: buyer.id, body: directOrder('20'), headers: { 'idempotency-key': key } });
const direct = r.body;
check('a direct order is placed', r.status === 201 && direct.total === '19000', r);
r = await call('POST', '/purchase-orders', { token: alice.token, org: buyer.id, body: directOrder('20'), headers: { 'idempotency-key': key } });
check('retrying with the same key returns the same order', r.status === 200 && r.body.id === direct.id && r.headers.get('idempotent-replayed') === 'true', r);
r = await call('POST', '/purchase-orders', { token: alice.token, org: buyer.id, body: directOrder('25'), headers: { 'idempotency-key': key } });
check('reusing the key for a different order is refused', r.status === 422 && r.body.error.code === 'idempotency_key_reused', r);
r = await call('POST', `/sales-orders/${direct.id}/cancel`, { token: carol.token, org: otherSupplier.id, body: { reason: 'out of stock' } });
check('the supplier can decline an unconfirmed order', r.body.status === 'cancelled', r);

// =============================================================================
heading('Notifications from events');
const inbox = (user) => waitFor(async () => (await call('GET', '/notifications?limit=50', { token: user.token })).body.items);
const has = async (user, template) =>
  waitFor(async () => (await call('GET', '/notifications?limit=50', { token: user.token })).body.items?.find((n) => n.templateKey === template));
check('supplier is told about the invited RFQ', !!(await has(bob, 'rfq_published')));
check('buyer is told about the quotation', !!(await has(alice, 'quotation_submitted')));
const poNote = await has(bob, 'purchase_order_created');
check('supplier is told about the new order, in Amharic', /[ሀ-፿]/.test(poNote?.title ?? ''), poNote);
check('buyer is told the order was confirmed', !!(await has(dave, 'purchase_order_confirmed')));
check('buyer hears the supplier declined the direct order', !!(await has(alice, 'purchase_order_cancelled')));
check('the invitee is welcomed to the organization', !!(await has(dave, 'membership_added')));
void inbox;

// =============================================================================
heading('Sessions & rate limits');
r = await call('POST', '/auth/refresh', { body: { refreshToken: alice.refreshToken } });
const rotated = r.body;
check('refresh rotates the token', r.status === 200 && rotated.refreshToken !== alice.refreshToken, r);
r = await call('POST', '/auth/refresh', { body: { refreshToken: alice.refreshToken } });
check('reusing an old refresh token is rejected', r.status === 401, r);
r = await call('GET', '/organizations', { token: rotated.accessToken });
check('…and revokes the session family everywhere', r.status === 401, r);
r = await call('POST', '/auth/logout', { token: bob.token });
r = await call('GET', '/notifications', { token: bob.token });
check('access tokens stop working right after logout', r.status === 401, r);

let limited = null;
for (let i = 0; i < 200 && !limited; i++) {
  const res = await call('POST', '/auth/password/forgot', { body: { email: `flood-${i}@example.com` } });
  if (res.status === 429) limited = res;
}
check('auth endpoints are rate limited (shared counter in Redis)', limited?.body?.error?.code === 'rate_limited' && !!limited.headers.get('retry-after'), limited?.body);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
