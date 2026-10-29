// Demo data for local development and demos: pnpm seed
//
// Seeds every service through the public API (via the gateway), so each
// service's rules apply and its events fan out — Discovery's index, Analytics,
// notifications and supplier performance fill themselves. Reference data the
// platform needs to run (catalog categories, verification policies) is seeded
// by the services themselves at startup.
//
// Idempotent: if the demo accounts already exist, it prints their logins and stops.
// Needs the infrastructure and every service + gateway running.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { adminSession, call, inDays, PDF, PNG, signCallback, tokenFrom, upload, waitFor, waitForEmail } from './smoke-lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const envOf = (path) => Object.fromEntries([...readFileSync(`${root}${path}`, 'utf8').matchAll(/^([A-Z0-9_]+)=(.*)$/gm)].map((m) => [m[1], m[2]]));
const providerSecret = (name) => envOf('services/integration/.env').PROVIDERS.split(',').find((p) => p.startsWith(`${name}:`)).split(':')[2];

const PASSWORD = 'Demo-pass-2026!';
const DOMAIN = 'demo.uboce.local';
const PEOPLE = {
  selam: { displayName: 'Selam Tadesse', locale: 'am', note: 'Owner, Sidama Coffee Farmers Cooperative Union (supplier)' },
  dawit: { displayName: 'Dawit Bekele', locale: 'en', note: 'Sales representative, Sidama union' },
  hana: { displayName: 'Hana Girma', locale: 'en', note: 'Owner, Addis Roasters PLC (buyer)' },
  yonas: { displayName: 'Yonas Alemu', locale: 'am', note: 'Procurement officer, Addis Roasters' },
  meron: { displayName: 'Meron Assefa', locale: 'en', note: 'Owner, Ethio Agro Processing (manufacturer, supplier)' },
  kebede: { displayName: 'Kebede Worku', locale: 'am', note: 'Owner, Habesha Logistics' },
};
const emailOf = (key) => `${key}@${DOMAIN}`;

// ---- tiny step runner -------------------------------------------------------------

let steps = 0;
// Thrown after printing the reason; exiting by exception (not process.exit) lets open sockets close cleanly.
class SeedError extends Error {}
async function ok(label, promise, expected = [200, 201, 202, 204]) {
  const res = await promise;
  if (!expected.includes(res.status)) {
    console.error(`\n✗ ${label} → HTTP ${res.status}\n${JSON.stringify(res.body, null, 2).slice(0, 1500)}`);
    throw new SeedError();
  }
  steps++;
  return res.body;
}
const section = (title) => console.log(`• ${title}`);
const until = async (label, fn, timeoutMs = 30_000) => {
  const value = await waitFor(fn, timeoutMs);
  if (!value) {
    console.error(`\n✗ timed out waiting for: ${label}`);
    throw new SeedError();
  }
  return value;
};

function printLogins(adminEmail) {
  console.log(`\nDemo logins (password for all: ${PASSWORD})`);
  for (const [key, p] of Object.entries(PEOPLE)) console.log(`  ${emailOf(key).padEnd(28)} ${p.note}`);
  console.log(`  ${adminEmail.padEnd(28)} Platform admin — MFA secret in .smoke-admin.json`);
  console.log('\nAPI docs: http://localhost:4100/docs   ·   Emails: http://localhost:8025');
}

// ---- already seeded? ---------------------------------------------------------------

const adminEmail = envOf('services/administration/.env').ADMIN_BOOTSTRAP_EMAILS.split(',')[0];
const probe = await call('POST', '/auth/login', { body: { email: emailOf('selam'), password: PASSWORD } });
async function seed() {
  console.log('Seeding demo data through the gateway…\n');

  // ---- Identity: people, verified emails ----------------------------------------------

  section('Identity: 6 people with verified emails');
  const users = {};
  for (const [key, p] of Object.entries(PEOPLE)) {
    const tokens = await ok(`register ${key}`, call('POST', '/auth/register', { body: { email: emailOf(key), password: PASSWORD, displayName: p.displayName, locale: p.locale } }));
    const me = await ok(`me ${key}`, call('GET', '/auth/me', { token: tokens.accessToken }));
    const mail = await until(`verification email for ${key}`, () => waitForEmail(emailOf(key), /Confirm your email|ኢሜይል/));
    await ok(`verify ${key}`, call('POST', '/auth/email/verify', { body: { token: tokenFrom(mail) } }));
    users[key] = { ...tokens, id: me.id, token: tokens.accessToken, email: emailOf(key) };
  }
  const { selam, dawit, hana, yonas, meron, kebede } = users;
  const admin = await adminSession(root, adminEmail);

  // ---- Organization: orgs, branches, invitations ----------------------------------------

  section('Organization: 4 organizations, branches, invited team members');
  const createOrg = (user, body) => ok(`org ${body.name}`, call('POST', '/organizations', { token: user.token, body }));
  const sidama = (await createOrg(selam, { name: 'Sidama Coffee Farmers Cooperative Union', legalName: 'Sidama Coffee Farmers Cooperative Union Ltd.', type: 'cooperative' })).id;
  const roasters = (await createOrg(hana, { name: 'Addis Roasters PLC', legalName: 'Addis Roasters Private Limited Company', type: 'business' })).id;
  const agro = (await createOrg(meron, { name: 'Ethio Agro Processing', legalName: 'Ethio Agro Processing Share Company', type: 'manufacturer' })).id;
  await createOrg(kebede, { name: 'Habesha Logistics', type: 'logistics_provider' });

  await ok('branch', call('POST', `/organizations/${sidama}/branches`, { token: selam.token, body: { name: 'Hawassa head office', region: 'Sidama', city: 'Hawassa' } }));
  await ok('branch', call('POST', `/organizations/${roasters}/branches`, { token: hana.token, body: { name: 'Bole roastery', region: 'Addis Ababa', city: 'Addis Ababa' } }));

  const invite = async (owner, orgId, orgName, member, role) => {
    await ok(`invite ${member.email}`, call('POST', `/organizations/${orgId}/invitations`, { token: owner.token, body: { email: member.email, role } }));
    const mail = await until(`invitation for ${member.email}`, () => waitForEmail(member.email, new RegExp(orgName.split(' ')[0])));
    await ok(`accept ${member.email}`, call('POST', '/invitations/accept', { token: member.token, body: { token: tokenFrom(mail) } }));
  };
  await invite(selam, sidama, 'Sidama', dawit, 'sales_representative');
  await invite(hana, roasters, 'Addis', yonas, 'procurement_officer');

  // ---- Administration: settings & a pilot flag -------------------------------------------

  section('Administration: platform settings and a pilot feature flag');
  const why = { reasonCode: 'demo_seed', reason: 'Initial demo configuration' };
  await ok('setting', call('PUT', '/admin/settings/platform.support_email', { token: admin.token, body: { value: 'support@uboce.local', description: 'Shown in emails and the app', ...why } }));
  await ok('setting', call('PUT', '/admin/settings/platform.default_currency', { token: admin.token, body: { value: 'ETB', ...why } }));
  await ok('setting', call('PUT', '/admin/settings/finance.default_vat_pct', { token: admin.token, body: { value: '15', description: 'Suggested VAT for Ethiopian invoices; confirm with tax advisors', ...why } }));
  await ok('flag', call('PUT', '/admin/feature-flags/procurement.reverse_auction', { token: admin.token, body: { enabled: false, organizationIds: [roasters], description: 'Pilot: reverse auctions for buyers', ...why } }));

  // ---- Document + KYB/KYC -------------------------------------------------------------------

  section('Documents + KYB: two verified suppliers, one buyer under review; KYC for the buyer owner');
  const evidence = async (user, orgId, label) => {
    const pdf = (classification, name) => upload(user, orgId, { classification, fileName: `${name}.pdf`, contentType: 'application/pdf', bytes: PDF(`${label} ${name}`) });
    return {
      business_registration: (await ok('upload', pdf('business_registration', 'commercial-registration'))).id,
      trade_license: (await ok('upload', pdf('license', 'trade-license'))).id,
      tax_registration: (await ok('upload', pdf('tax_certificate', 'tin-certificate'))).id,
      representative_id: (await ok('upload', pdf('identity_document', 'representative-id'))).id,
    };
  };
  const kybCase = async (user, orgId, label) => {
    const docs = await evidence(user, orgId, label);
    const c = await ok('kyb case', call('POST', '/kyb/cases', { token: user.token, org: orgId, body: { tier: 'standard' } }));
    for (const [requirement, documentId] of Object.entries(docs)) {
      await ok('kyb evidence', call('POST', `/kyb/cases/${c.id}/evidence`, { token: user.token, org: orgId, body: { requirement, documentId } }));
    }
    await ok('kyb submit', call('POST', `/kyb/cases/${c.id}/submit`, { token: user.token, org: orgId }));
    return c.id;
  };
  const approveKyb = async (caseId, owner, orgId) => {
    await ok('kyb claim', call('POST', `/kyb/review/cases/${caseId}/claim`, { token: admin.token }));
    await ok('kyb check', call('POST', `/kyb/review/cases/${caseId}/checks`, { token: admin.token, body: { type: 'registry_lookup', result: 'pass', details: 'Matches the trade registry (demo)' } }));
    await ok('kyb approve', call('POST', `/kyb/review/cases/${caseId}/decision`, { token: admin.token, body: { decision: 'approved', reasonCode: 'all_checks_passed' } }));
    await until(`verified status for ${orgId}`, async () => (await call('GET', `/organizations/${orgId}`, { token: owner.token })).body.verificationStatus === 'verified');
  };
  await approveKyb(await kybCase(selam, sidama, 'Sidama union'), selam, sidama);
  await approveKyb(await kybCase(meron, agro, 'Ethio Agro'), meron, agro);
  await kybCase(hana, roasters, 'Addis Roasters'); // left in the review queue for demos

  const nationalId = await ok('upload id', upload(hana, undefined, { classification: 'identity_document', fileName: 'kebele-id.pdf', contentType: 'application/pdf', bytes: PDF('Hana national id') }));
  const kyc = await ok('kyc case', call('POST', '/kyc/cases', { token: hana.token, body: { tier: 'basic' } }));
  await ok('kyc evidence', call('POST', `/kyc/cases/${kyc.id}/evidence`, { token: hana.token, body: { requirement: 'national_id', documentId: nationalId.id } }));
  await ok('kyc submit', call('POST', `/kyc/cases/${kyc.id}/submit`, { token: hana.token }));
  await ok('kyc claim', call('POST', `/kyc/review/cases/${kyc.id}/claim`, { token: admin.token }));
  await ok('kyc approve', call('POST', `/kyc/review/cases/${kyc.id}/decision`, { token: admin.token, body: { decision: 'approved', reasonCode: 'id_verified' } }));

  // ---- Catalog (→ Discovery) ----------------------------------------------------------------

  section('Catalog: 7 published products (indexed by Discovery)');
  const categories = await ok('categories', call('GET', '/catalog/categories'));
  const cat = (slug) => categories.find((c) => c.slug === slug).id;
  const sku = (prefix) => `${prefix}-${randomUUID().slice(0, 6).toUpperCase()}`;
  const variantsOf = {};
  const publish = async (user, orgId, body) => {
    const p = await ok(`product ${body.name}`, call('POST', '/catalog/products', { token: user.token, org: orgId, body }));
    await ok('publish', call('POST', `/catalog/products/${p.id}/publish`, { token: user.token, org: orgId }));
    variantsOf[p.id] = p.variants;
    return p.id;
  };
  const sidamaG1 = await publish(selam, sidama, {
    name: 'Sidama Grade 1 Washed Green Coffee',
    description: 'Bensa and Aroresa smallholders, 1,900–2,300 m. Floral, citrus, black tea.',
    categoryId: cat('coffee'),
    unitOfMeasure: 'kg',
    attributes: { origin: 'Sidama', grade: '1', process: 'washed', altitude_m: '2100', crop_year: '2026' },
    variants: [
      { sku: sku('SID-G1-60'), name: '60 kg jute bag (per kg)', price: '465.00', currency: 'ETB', minOrderQuantity: '600' },
      { sku: sku('SID-G1-S'), name: 'Sample', price: '520.00', currency: 'ETB' },
    ],
  });
  const guji = await publish(selam, sidama, {
    name: 'Guji Natural Grade 2 Green Coffee',
    description: 'Sun-dried on raised beds. Berry, chocolate.',
    categoryId: cat('coffee'),
    unitOfMeasure: 'kg',
    attributes: { origin: 'Guji', grade: '2', process: 'natural' },
    variants: [{ sku: sku('GUJ-G2'), name: 'Per kg', price: '410.00', currency: 'ETB', minOrderQuantity: '300' }],
  });
  await publish(selam, sidama, {
    name: 'Yirgacheffe Washed Grade 1',
    categoryId: cat('coffee'),
    unitOfMeasure: 'kg',
    attributes: { origin: 'Yirgacheffe', grade: '1', process: 'washed' },
    variants: [{ sku: sku('YIR-G1'), name: 'Per kg', price: '490.00', currency: 'ETB' }],
  });
  const teffFlour = await publish(meron, agro, {
    name: 'White Teff Flour',
    description: 'Stone-milled Magna teff, 25 kg bags.',
    categoryId: cat('teff'),
    unitOfMeasure: 'kg',
    attributes: { variety: 'white', cultivar: 'Magna' },
    variants: [{ sku: sku('TEF-W25'), name: '25 kg bag (per kg)', price: '145.00', currency: 'ETB', minOrderQuantity: '250' }],
  });
  await publish(meron, agro, {
    name: 'Humera Sesame Seed',
    categoryId: cat('sesame'),
    unitOfMeasure: 'quintal',
    attributes: { grade: 'Export grade 1' },
    variants: [{ sku: sku('SES-HUM'), name: 'Per quintal', price: '14500.00', currency: 'ETB' }],
  });
  const roastedCoffee = await publish(meron, agro, {
    name: 'Medium Roast Ethiopian Coffee',
    description: 'Roasted from Sidama Grade 1 washed.',
    categoryId: cat('food-processing'),
    unitOfMeasure: 'kg',
    attributes: { roast: 'medium' },
    variants: [{ sku: sku('RST-MED'), name: 'Per kg', price: '980.00', currency: 'ETB' }],
  });
  await publish(meron, agro, {
    name: 'Kraft Valve Coffee Bags (1 kg)',
    categoryId: cat('packaging'),
    unitOfMeasure: 'piece',
    attributes: {},
    variants: [{ sku: sku('PKG-1KG'), name: 'Per bag', price: '18.50', currency: 'ETB' }],
  });

  // ---- PRD addendum: bulk tiers, a policy, a promotion, a location --------------------------
  section('Addendum: price tiers, cancellation policy, promotion, pickup location');
  await ok('price tiers', call('PUT', `/catalog/products/${sidamaG1}/variants/${variantsOf[sidamaG1][0].id}/price-tiers`, {
    token: selam.token,
    org: sidama,
    body: { tiers: [{ minQuantity: '1200', unitPrice: '455.00' }, { minQuantity: '6000', unitPrice: '440.00' }] },
  }));
  await ok('cancellation policy', call('POST', '/cancellation-policies', {
    token: meron.token,
    org: agro,
    body: { name: 'Standard terms', freeCancellationHours: 24, cancellationFeePct: '10', noShowFeePct: '5', returnWindowDays: 7, restockingFeePct: '10', pickupHoldHours: 72 },
  }));
  await ok('promotion', call('POST', '/promotions', {
    token: meron.token,
    org: agro,
    body: { name: 'Harvest 5% off', code: 'HARVEST5', kind: 'percent', value: '5', currency: 'ETB', minSubtotal: '10000' },
  }));
  await ok('pickup location', call('POST', `/organizations/${agro}/branches`, {
    token: meron.token,
    body: {
      name: 'Merkato pickup point',
      kind: 'collection_point',
      city: 'Addis Ababa',
      pickupEnabled: true,
      serviceAreas: ['Addis Ababa', 'Adama'],
      operatingHours: [1, 2, 3, 4, 5].map((day) => ({ day, opens: '08:00', closes: '18:00' })).concat([{ day: 6, opens: '09:00', closes: '13:00' }]),
    },
  }));

  // ---- Warehouse, Inventory, Quality --------------------------------------------------------

  section('Warehouse & Inventory: 3 warehouses, receipts, an inspection, a transfer');
  const warehouse = (user, orgId, body) => ok(`warehouse ${body.code}`, call('POST', '/warehouse/warehouses', { token: user.token, org: orgId, body }));
  const hawassa = (await warehouse(selam, sidama, { code: 'HWS-01', name: 'Hawassa dry mill', region: 'Sidama', city: 'Hawassa' })).id;
  const addisDepot = (await warehouse(selam, sidama, { code: 'ADD-01', name: 'Addis Ababa depot', region: 'Addis Ababa', city: 'Addis Ababa' })).id;
  const adama = (await warehouse(meron, agro, { code: 'ADM-01', name: 'Adama processing plant', region: 'Oromia', city: 'Adama' })).id;
  await ok('location', call('POST', `/warehouse/warehouses/${hawassa}/locations`, { token: selam.token, org: sidama, body: { code: 'BAY-A1', description: 'Green coffee, washed' } }));

  const receive = (user, orgId, body) => ok('receipt', call('POST', '/warehouse/receipts', { token: user.token, org: orgId, body }));
  await receive(selam, sidama, {
    warehouseId: hawassa,
    inspectionRequired: false,
    lines: [
      { itemId: sidamaG1, description: 'Sidama G1 washed', expectedQuantity: '12000', receivedQuantity: '12000' },
      { itemId: guji, description: 'Guji G2 natural', expectedQuantity: '6000', receivedQuantity: '5940', rejectedQuantity: '60', discrepancyNote: 'One bag wet on arrival' },
    ],
  });
  const held = await receive(selam, sidama, {
    warehouseId: hawassa,
    inspectionRequired: true,
    notes: 'Late-season lot, check moisture',
    lines: [{ itemId: sidamaG1, description: 'Sidama G1 washed (late season)', receivedQuantity: '1800' }],
  });
  const inspection = await until('inspection for held receipt', async () =>
    (await call('GET', '/quality/inspections?status=pending', { token: selam.token, org: sidama })).body.items?.find((i) => i.subjectId === held.id),
  );
  await ok('inspection results', call('POST', `/quality/inspections/${inspection.id}/results`, {
    token: selam.token,
    org: sidama,
    body: {
      decision: 'conditionally_accepted',
      criteria: { moisture_max_pct: '11.5', defects_max_per_300g: '5' },
      notes: '120 kg above moisture limit',
      lines: [{ itemId: sidamaG1, acceptedQuantity: '1680', rejectedQuantity: '120' }],
      nonconformances: [{ description: 'Moisture 12.8% in 2 bags', severity: 'minor' }],
    },
  }));
  await receive(selam, sidama, { warehouseId: hawassa, inspectionRequired: true, lines: [{ itemId: guji, description: 'Guji G2 (awaiting inspection)', receivedQuantity: '900' }] });

  await receive(meron, agro, {
    warehouseId: adama,
    inspectionRequired: false,
    lines: [
      { itemId: sidamaG1, description: 'Green coffee for roasting', receivedQuantity: '2400' },
      { itemId: teffFlour, description: 'White teff flour', receivedQuantity: '8000' },
    ],
  });
  await until('accepted inspection stock', async () => {
    const b = await call('GET', `/inventory/balances?itemId=${sidamaG1}&warehouseId=${hawassa}`, { token: selam.token, org: sidama });
    return Number(b.body.items?.[0]?.onHand) === 13680;
  });
  await ok('transfer', call('POST', '/warehouse/transfers', { token: selam.token, org: sidama, body: { fromWarehouseId: hawassa, toWarehouseId: addisDepot, itemId: sidamaG1, quantity: '2000' } }));

  // ---- Agriculture --------------------------------------------------------------------

  section('Agriculture: 3 farms, meher-season harvests, lots with lineage');
  const farms = [];
  for (const f of [
    { name: 'Bensa — Tadesse family farm', region: 'Sidama', zone: 'Sidama', woreda: 'Bensa', areaHectares: '1.8', latitude: '6.5600', longitude: '38.7200' },
    { name: 'Aroresa — Abebe smallholding', region: 'Sidama', zone: 'Sidama', woreda: 'Aroresa', areaHectares: '0.9' },
    { name: 'Shebedino — Lemma garden', region: 'Sidama', zone: 'Sidama', woreda: 'Shebedino', areaHectares: '1.2' },
  ]) {
    farms.push(await ok(`farm ${f.name}`, call('POST', '/agriculture/farms', { token: selam.token, org: sidama, body: f })));
  }
  await ok('plot', call('POST', `/agriculture/farms/${farms[0].id}/plots`, { token: selam.token, org: sidama, body: { name: 'Upper terrace', areaHectares: '0.6' } }));
  const harvests = [];
  for (const [i, farm] of farms.entries()) {
    const season = await ok('season', call('POST', '/agriculture/seasons', { token: selam.token, org: sidama, body: { farmId: farm.id, crop: 'coffee', year: 2026, season: 'meher', unitOfMeasure: 'kg', expectedHarvestQuantity: String(900 + i * 150) } }));
    for (const qty of ['420', '380']) {
      harvests.push(await ok('harvest', call('POST', `/agriculture/seasons/${season.id}/harvests`, { token: selam.token, org: sidama, body: { harvestedAt: inDays(-30 + harvests.length), quantity: qty, notes: 'Red cherry, hand-picked' } })));
    }
  }
  const lotA = await ok('lot', call('POST', '/agriculture/lots', {
    token: selam.token,
    org: sidama,
    body: { productId: sidamaG1, grade: 'Grade 1', warehouseId: hawassa, harvests: harvests.slice(0, 4).map((h) => ({ harvestId: h.id, quantity: h.quantity })) },
  }));
  await ok('lot', call('POST', '/agriculture/lots', { token: selam.token, org: sidama, body: { warehouseId: hawassa, harvests: harvests.slice(4).map((h) => ({ harvestId: h.id, quantity: h.quantity })) } }));
  await ok('grade', call('POST', `/agriculture/lots/${lotA.id}/grade`, { token: selam.token, org: sidama, body: { grade: 'Grade 1', moisturePct: '10.8', defectCount: 3, notes: 'Cupping score 87' } }));
  await ok('split', call('POST', `/agriculture/lots/${lotA.id}/split`, { token: selam.token, org: sidama, body: { quantities: ['1000', '600'] } }));

  // ---- Manufacturing -------------------------------------------------------------------

  section('Manufacturing: a roasting recipe, one completed run, one released order');
  const bom = await ok('bom', call('POST', '/manufacturing/boms', {
    token: meron.token,
    org: agro,
    body: { name: 'Medium roast (Sidama G1)', outputItemId: roastedCoffee, outputQuantity: '100', unitOfMeasure: 'kg', components: [{ itemId: sidamaG1, description: 'Green coffee', quantity: '118', unitOfMeasure: 'kg' }] },
  }));
  const run1 = await ok('production order', call('POST', '/manufacturing/production-orders', { token: meron.token, org: agro, body: { bomId: bom.id, plannedOutput: '1000', warehouseId: adama } }));
  await ok('release', call('POST', `/manufacturing/production-orders/${run1.id}/release`, { token: meron.token, org: agro }));
  await ok('complete', call('POST', `/manufacturing/production-orders/${run1.id}/complete`, { token: meron.token, org: agro, body: { outputQuantity: '968', wasteQuantity: '24', notes: 'Chaff and broken beans' } }));
  const run2 = await ok('production order', call('POST', '/manufacturing/production-orders', { token: meron.token, org: agro, body: { bomId: bom.id, plannedOutput: '500', warehouseId: adama } }));
  await ok('release', call('POST', `/manufacturing/production-orders/${run2.id}/release`, { token: meron.token, org: agro }));

  // ---- Procurement → Commerce -----------------------------------------------------------

  section('Procurement & Commerce: RFQs, quotations, an award, orders');
  const rfq = await ok('rfq', call('POST', '/rfqs', {
    token: yonas.token,
    org: roasters,
    body: {
      title: 'Washed green coffee for Q1 2027 roasting',
      description: 'Specialty-grade washed, cupping 85+. Samples required.',
      currency: 'ETB',
      deliveryTerms: 'DAP Addis Ababa, within 21 days of order',
      deliveryLocation: 'Bole roastery, Addis Ababa',
      responseDeadline: inDays(10),
      visibility: 'invited',
      invitedSupplierOrganizationIds: [sidama, agro],
      lines: [
        { productId: sidamaG1, description: 'Washed Grade 1 green coffee', quantity: '1200', unitOfMeasure: 'kg', specifications: { moisture_max_pct: '11.5' } },
        { description: 'Jute bags, 60 kg', quantity: '20', unitOfMeasure: 'piece' },
      ],
    },
  }));
  await ok('publish rfq', call('POST', `/rfqs/${rfq.id}/publish`, { token: yonas.token, org: roasters }));
  const quote = (user, orgId, prices, validDays = 14) =>
    ok('quotation', call('POST', `/rfqs/${rfq.id}/quotations`, {
      token: user.token,
      org: orgId,
      body: { validUntil: inDays(validDays), notes: 'Prices exclude VAT', lines: rfq.lines.map((l, i) => ({ rfqLineId: l.id, unitPrice: prices[i], leadTimeDays: 7 })) },
    }));
  await quote(dawit, sidama, ['470.00', '95.00']);
  const sidamaQuote = await quote(dawit, sidama, ['458.00', '90.00']); // a revision
  await quote(meron, agro, ['489.00', '110.00']);
  await ok('accept', call('POST', `/rfqs/${rfq.id}/quotations/${sidamaQuote.id}/accept`, { token: yonas.token, org: roasters }));
  const awardedOrder = (
    await until('order from accepted quotation', async () => (await call('GET', `/purchase-orders?quotationId=${sidamaQuote.id}`, { token: hana.token, org: roasters })).body.items?.[0])
  );
  await ok('confirm', call('POST', `/sales-orders/${awardedOrder.id}/confirm`, { token: dawit.token, org: sidama }));

  const openRfq = await ok('rfq', call('POST', '/rfqs', {
    token: yonas.token,
    org: roasters,
    body: { title: 'Natural process coffee for espresso blend', currency: 'ETB', responseDeadline: inDays(14), visibility: 'open', lines: [{ description: 'Natural Grade 2', quantity: '800', unitOfMeasure: 'kg' }] },
  }));
  await ok('publish rfq', call('POST', `/rfqs/${openRfq.id}/publish`, { token: yonas.token, org: roasters }));
  await ok('quotation', call('POST', `/rfqs/${openRfq.id}/quotations`, { token: dawit.token, org: sidama, body: { validUntil: inDays(20), lines: [{ rfqLineId: openRfq.lines[0].id, unitPrice: '405.00', leadTimeDays: 10 }] } }));
  await ok('draft rfq', call('POST', '/rfqs', {
    token: yonas.token,
    org: roasters,
    body: { title: 'Packaging for retail line (draft)', currency: 'ETB', responseDeadline: inDays(30), visibility: 'invited', invitedSupplierOrganizationIds: [agro], lines: [{ description: '1 kg valve bags', quantity: '5000', unitOfMeasure: 'piece' }] },
  }));

  const teffOrder = await ok('direct order', call('POST', '/purchase-orders', {
    token: hana.token,
    org: roasters,
    headers: { 'idempotency-key': `seed-teff-${randomUUID()}` },
    body: { supplierOrganizationId: agro, currency: 'ETB', title: 'Teff flour for staff canteen', deliveryLocation: 'Bole roastery', lines: [{ variantId: variantsOf[teffFlour][0].id, quantity: '500' }] },
  }));
  await ok('confirm', call('POST', `/sales-orders/${teffOrder.id}/confirm`, { token: meron.token, org: agro }));
  await ok('pending order', call('POST', '/purchase-orders', {
    token: hana.token,
    org: roasters,
    headers: { 'idempotency-key': `seed-roast-${randomUUID()}` },
    body: { supplierOrganizationId: agro, currency: 'ETB', title: 'Roasted coffee for café', lines: [{ variantId: variantsOf[roastedCoffee][0].id, quantity: '120' }] },
  }));

  // ---- Logistics + Integration (carrier) -----------------------------------------------------

  section('Logistics & Integration: shipments, carrier tracking webhook, deliveries');
  await until('stock reserved for awarded order', async () => (await call('GET', `/inventory/reservations/order/${awardedOrder.id}`, { token: selam.token, org: sidama })).status === 200);
  const coffeeLine = awardedOrder.lines.find((l) => l.productId === sidamaG1);
  const bagsLine = awardedOrder.lines.find((l) => l.productId === null);
  const tracking = `HBL-${randomUUID().slice(0, 8).toUpperCase()}`;
  const shipment1 = await ok('shipment', call('POST', '/shipments', {
    token: dawit.token,
    org: sidama,
    body: { orderId: awardedOrder.id, originWarehouseId: hawassa, carrierName: 'Habesha Logistics', trackingNumber: tracking, expectedDeliveryAt: inDays(3), items: [{ orderLineId: coffeeLine.id, quantity: '720' }, { orderLineId: bagsLine.id, quantity: '12' }] },
  }));
  await ok('dispatch', call('POST', `/shipments/${shipment1.id}/dispatch`, { token: dawit.token, org: sidama }));
  const carrierSecret = providerSecret('testcarrier');
  for (const [status, location] of [['in_transit', 'Shashemene'], ['in_transit', 'Mojo dry port']]) {
    const body = JSON.stringify({ eventId: `seed-${randomUUID()}`, trackingNumber: tracking, status, location, occurredAt: new Date().toISOString() });
    await ok('carrier webhook', call('POST', '/integrations/callbacks/testcarrier', { body, headers: signCallback(carrierSecret, body) }));
  }
  const pod = await ok('delivery note', upload(hana, roasters, { classification: 'delivery_evidence', fileName: 'signed-delivery-note.pdf', contentType: 'application/pdf', bytes: PDF('Signed delivery note') }));
  await ok('confirm delivery', call('POST', `/shipments/${shipment1.id}/confirm-delivery`, {
    token: yonas.token,
    org: roasters,
    body: { recipientName: 'Yonas Alemu', documentIds: [pod.id], notes: '2 bags short-weighted', items: [{ orderLineId: coffeeLine.id, deliveredQuantity: '700' }, { orderLineId: bagsLine.id, deliveredQuantity: '12' }] },
  }));
  const shipment2 = await ok('shipment', call('POST', '/shipments', { token: dawit.token, org: sidama, body: { orderId: awardedOrder.id, originWarehouseId: hawassa, carrierName: 'Habesha Logistics', items: [{ orderLineId: coffeeLine.id, quantity: '480' }] } }));
  await ok('dispatch', call('POST', `/shipments/${shipment2.id}/dispatch`, { token: dawit.token, org: sidama }));

  await until('stock reserved for teff order', async () => (await call('GET', `/inventory/reservations/order/${teffOrder.id}`, { token: meron.token, org: agro })).status === 200);
  const teffShipment = await ok('shipment', call('POST', '/shipments', { token: meron.token, org: agro, body: { orderId: teffOrder.id, originWarehouseId: adama, items: [{ orderLineId: teffOrder.lines[0].id, quantity: '500' }] } }));
  await ok('dispatch', call('POST', `/shipments/${teffShipment.id}/dispatch`, { token: meron.token, org: agro }));
  await ok('confirm delivery', call('POST', `/shipments/${teffShipment.id}/confirm-delivery`, { token: hana.token, org: roasters, body: { recipientName: 'Hana Girma', items: [{ orderLineId: teffOrder.lines[0].id, deliveredQuantity: '500' }] } }));
  await until('teff order fulfilled', async () => (await call('GET', `/purchase-orders/${teffOrder.id}`, { token: hana.token, org: roasters })).body.status === 'fulfilled');
  await ok('close order', call('POST', `/purchase-orders/${teffOrder.id}/close`, { token: hana.token, org: roasters }));

  // ---- Finance + Integration (payments) ------------------------------------------------------

  section('Finance & Integration: invoices, a payment claim, provider payments');
  const coffeeInvoice = await ok('invoice', call('POST', '/invoices/from-order', { token: selam.token, org: sidama, body: { orderId: awardedOrder.id, taxRatePct: '15', dueInDays: 30, notes: 'Bank: CBE, account 1000-000-000 (demo)' } }));
  await ok('issue', call('POST', `/invoices/${coffeeInvoice.id}/issue`, { token: selam.token, org: sidama }));
  await ok('payment claim', call('POST', `/invoices/${coffeeInvoice.id}/payments`, { token: hana.token, org: roasters, body: { provider: 'bank_transfer', externalReference: `CBE-${randomUUID().slice(0, 8).toUpperCase()}`, amount: '200000.00', paidAt: new Date().toISOString() } }));
  const paySecret = providerSecret('testpay');
  const pay = (invoice, amount) => {
    const body = JSON.stringify({ eventId: `seed-${randomUUID()}`, type: 'payment.confirmed', reference: `TP-${randomUUID().slice(0, 10)}`, invoiceNumber: invoice.number, amount, currency: 'ETB', occurredAt: new Date().toISOString() });
    return ok('payment webhook', call('POST', '/integrations/callbacks/testpay', { body, headers: signCallback(paySecret, body) }));
  };
  await pay(coffeeInvoice, '300000.00');
  const teffInvoice = await ok('invoice', call('POST', '/invoices/from-order', { token: meron.token, org: agro, body: { orderId: teffOrder.id, taxRatePct: '15', dueInDays: 15 } }));
  await ok('issue', call('POST', `/invoices/${teffInvoice.id}/issue`, { token: meron.token, org: agro }));
  await pay(teffInvoice, teffInvoice.total);
  await ok('draft invoice', call('POST', '/invoices', { token: meron.token, org: agro, body: { buyerOrganizationId: roasters, currency: 'ETB', dueInDays: 30, notes: 'Roasting trial (draft)', lines: [{ description: 'Sample roasting service', quantity: '1', unitPrice: '4500.00', taxRatePct: '15' }] } }));

  // ---- Disputes ---------------------------------------------------------------------------

  section('Dispute & Performance: a quantity dispute with evidence');
  const photo = await ok('photo', upload(yonas, roasters, { classification: 'dispute_evidence', fileName: 'scale-reading.png', contentType: 'image/png', bytes: PNG() }));
  const dispute = await ok('dispute', call('POST', '/disputes', {
    token: yonas.token,
    org: roasters,
    body: { subjectType: 'shipment', subjectId: shipment1.id, orderId: awardedOrder.id, category: 'quantity', description: 'Two bags weighed 10 kg under on our certified scale.', evidenceDocumentIds: [photo.id] },
  }));
  await ok('statement', call('POST', `/disputes/${dispute.id}/statements`, { token: dawit.token, org: sidama, body: { text: 'Our dispatch weights were correct; we will check with the carrier.' } }));

  // ---- Notification ----------------------------------------------------------------------

  section('Notification: a registered push device');
  await ok('device', call('POST', '/notifications/devices', { token: hana.token, body: { token: `demo-fcm-token-${randomUUID()}`, platform: 'android' } }));

  // ---- Let event-driven read models catch up -----------------------------------------------

  section('Waiting for Discovery, Analytics and Performance to catch up');
  await until('discovery index', async () => (await call('GET', '/discovery/products?q=sidama')).body.meta?.total >= 1);
  await until('analytics', async () => (await call('GET', '/analytics/summary', { token: selam.token, org: sidama })).body.counts?.orders_received >= 1);
  await until('performance facts', async () => (await call('GET', `/performance/suppliers/${sidama}`, { token: hana.token })).body.ordersReceived >= 1);

  console.log(`\nDone: ${steps} API calls succeeded across all 21 services.`);
}

if (probe.status === 200) console.log('Demo data is already seeded.');
else await seed();
printLogins(adminEmail);
