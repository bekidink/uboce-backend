// Business categories, sector search, branch-to-branch transfers, activity log, audit filters,
// report templates, store activity reports and buyer-side promotions.
// node scripts/smoke-branch-ops.mjs (stack running).
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { adminSession, call, check, finish, heading, newUser, register, waitFor } from './smoke-lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const admin = await adminSession(root, 'admin@uboce.local');
const tag = randomUUID().slice(0, 6).toUpperCase();
const key = () => `smoke-${randomUUID()}`;

heading('Setup: a wholesaler with two stores, a buyer');
const [own, clerk, buy] = await Promise.all(['BrOwner', 'BrClerk', 'BrBuyer'].map((n) => register(newUser(n))));
const org = (await call('POST', '/organizations', { token: own.token, body: { name: `Branch Traders ${tag}`, type: 'wholesaler' } })).body;
const buyer = (await call('POST', '/organizations', { token: buy.token, body: { name: `Branch Buyer ${tag}`, type: 'business' } })).body;
const O = { token: own.token, org: org.id };
const B = { token: buy.token, org: buyer.id };
const branch = async (name, city) => (await call('POST', `/organizations/${org.id}/branches`, { token: own.token, body: { name, kind: 'store', city } })).body;
const [bole, adama] = [await branch('Bole store', 'Addis Ababa'), await branch('Adama store', 'Adama')];
const wh = async (code, b) => (await call('POST', '/warehouse/warehouses', { ...O, body: { code: `${code}${tag}`.slice(0, 20), name: `${code} stock room`, branchId: b.id } })).body;
const [whBole, whAdama] = [await wh('BOL', bole), await wh('ADA', adama)];
check('two stores with stock rooms', whBole.id && whAdama.id, { whBole, whAdama });

heading('Business categories');
const platform = (await call('GET', '/catalog/categories')).body;
const electronics = platform.find((c) => c.slug === 'consumer-electronics');
check('new sectors seeded (electronics, health, energy…)', ['electronics', 'health', 'energy', 'apparel'].every((s) => platform.some((c) => c.slug === s)), platform.map((c) => c.slug));
const mine = await call('POST', '/catalog/categories', { ...O, body: { name: 'Phones & tablets', parentId: electronics.id, description: 'Our mobile range' } });
check('business creates its own category', mine.status === 201 && mine.body.organizationId === org.id, mine.body);
const dup = await call('POST', '/catalog/categories', { ...O, body: { name: 'phones & tablets', parentId: electronics.id } });
check('duplicate name refused', dup.status === 409, dup.body);
const underOwn = await call('POST', '/catalog/categories', { ...O, body: { name: 'Nested', parentId: mine.body.id } });
check('must sit under a platform category', underOwn.status === 400, underOwn.body);
const available = await call('GET', '/catalog/categories/available', O);
check('product forms see platform + own categories', available.body.some((c) => c.id === mine.body.id), available.status);
const publicList = await call('GET', '/catalog/categories');
check('public list stays platform-only', !publicList.body.some((c) => c.id === mine.body.id), null);
const otherSees = await call('GET', '/catalog/categories/available', B);
check("other businesses don't see it", !otherSees.body.some((c) => c.id === mine.body.id), null);

const product = (await call('POST', '/catalog/products', {
  ...O,
  body: { name: `Handset X${tag}`, categoryId: mine.body.id, unitOfMeasure: 'piece', attributes: { brand: 'Tecno' }, variants: [{ sku: `HX-${tag}`, name: 'Black', price: '9000.00', currency: 'ETB' }] },
})).body;
check('product in own category', product.categoryId === mine.body.id, product);
await call('POST', `/catalog/products/${product.id}/publish`, O);
const inUse = await call('DELETE', `/catalog/categories/${mine.body.id}`, O);
check('category in use cannot be deleted', inUse.status === 409, inUse.body);

heading('Marketplace: sector search, supplier type, assistant');
const bySector = await waitFor(async () => {
  const r = await call('GET', `/discovery/products?category=electronics&q=${encodeURIComponent(`Handset X${tag}`)}&facets=true`);
  return r.body.items?.some((p) => p.productId === product.id) ? r : null;
});
check('sector filter finds products in sub- and own categories', Boolean(bySector), null);
check('sector facets returned', bySector?.body.facets?.sectors?.some((s) => s.value === 'electronics'), bySector?.body.facets);
const byType = await call('GET', `/discovery/products?supplierType=wholesaler&q=${encodeURIComponent(`Handset X${tag}`)}`);
check('supplier type filter', byType.body.items?.some((p) => p.productId === product.id), byType.body);
const notType = await call('GET', `/discovery/products?supplierType=farm&q=${encodeURIComponent(`Handset X${tag}`)}`);
check('other supplier types excluded', !notType.body.items?.some((p) => p.productId === product.id), null);
const assistStatus = await call('GET', '/discovery/assist/status');
if (assistStatus.body?.enabled) {
  const assist = await call('POST', '/discovery/assist', { body: { prompt: 'verified wholesalers selling mobile phones under 12000 birr in Addis' } });
  check('assistant turns a request into filters', assist.status === 200 && assist.body.filters && (assist.body.filters.maxPrice || assist.body.filters.category || assist.body.filters.q), assist.body);
} else console.log('  (Groq not configured; skipping assistant)');

heading('Branch-to-branch transfer');
await call('POST', '/inventory/adjustments', { ...O, headers: { 'idempotency-key': key() }, body: { warehouseId: whBole.id, itemId: product.id, quantity: '50', reasonCode: 'opening_balance' } });
const added = await call('POST', `/organizations/${org.id}/members`, { token: own.token, body: { userId: clerk.id, role: 'warehouse_operator' } });
await call('PUT', `/organizations/${org.id}/members/${added.body.id}/locations`, { token: own.token, body: { branchIds: [adama.id] } });
const C = { token: clerk.token, org: org.id };
const network = await call('GET', '/warehouse/network', C);
check('Adama clerk sees every branch warehouse', network.body.length === 2 && network.body.find((w) => w.id === whAdama.id)?.mine && !network.body.find((w) => w.id === whBole.id)?.mine, network.body);
const balances = await call('GET', `/inventory/balances?itemId=${product.id}`, C);
check('…and Bole stock', balances.body.items?.some((b) => b.warehouseId === whBole.id && Number(b.available) === 50), balances.body);
const wrongWay = await call('POST', '/warehouse/transfer-requests', { ...C, body: { fromWarehouseId: whAdama.id, toWarehouseId: whBole.id, lines: [{ itemId: product.id, quantity: '5' }] } });
check('cannot request into another branch', wrongWay.status === 403, wrongWay.body);
const req = await call('POST', '/warehouse/transfer-requests', { ...C, body: { fromWarehouseId: whBole.id, toWarehouseId: whAdama.id, lines: [{ itemId: product.id, description: 'Handset X', quantity: '20' }], note: 'Weekend promo', neededBy: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10) } });
check('Adama asks Bole for 20', req.status === 201 && req.body.status === 'requested' && req.body.number?.startsWith('TR-'), req.body);
const rid = req.body.id;
const selfApprove = await call('POST', `/warehouse/transfer-requests/${rid}/respond`, { ...C, body: { decision: 'approve' } });
check('requester cannot approve', selfApprove.status === 403, selfApprove.body);
const incoming = await call('GET', '/warehouse/transfer-requests?direction=incoming', O);
check('owner sees it as incoming', incoming.body.items?.some((t) => t.id === rid), incoming.body);
const approve = await call('POST', `/warehouse/transfer-requests/${rid}/respond`, { ...O, body: { decision: 'approve', note: 'Only 15 spare', lines: [{ lineId: req.body.lines[0].id, quantity: '15' }] } });
check('Bole approves 15', approve.status === 200 && approve.body.status === 'approved' && Number(approve.body.lines[0].approvedQuantity) === 15, approve.body);
const send = await call('POST', `/warehouse/transfer-requests/${rid}/dispatch`, O);
check('Bole sends', send.status === 200 && send.body.status === 'in_transit', send.body);
const afterSend = await call('GET', `/inventory/balances?itemId=${product.id}&warehouseId=${whBole.id}`, O);
check('stock left Bole', Number(afterSend.body.items?.[0]?.onHand) === 35, afterSend.body);
const receive = await call('POST', `/warehouse/transfer-requests/${rid}/receive`, { ...C, body: { lines: [{ lineId: req.body.lines[0].id, quantity: '14' }], note: 'One box damaged' } });
check('Adama receives 14', receive.status === 200 && receive.body.status === 'received' && Number(receive.body.lines[0].receivedQuantity) === 14, receive.body);
const atAdama = await call('GET', `/inventory/balances?itemId=${product.id}&warehouseId=${whAdama.id}`, O);
check('stock arrived at Adama', Number(atAdama.body.items?.[0]?.onHand) === 14, atAdama.body);
const again = await call('POST', `/warehouse/transfer-requests/${rid}/receive`, C);
check('cannot receive twice', again.status === 409, again.body);

heading('Promotions: buyer side');
const promo = await call('POST', '/promotions', { ...O, body: { name: `Launch ${tag}`, code: `LAUNCH${tag}`, kind: 'percent', value: '5', currency: 'ETB', description: '5% off handsets', advertised: true } });
check('seller creates an advertised coupon', promo.status === 201 && promo.body.advertised === true, promo.body);
await call('POST', '/promotions', { ...O, body: { name: `Secret ${tag}`, code: `VIP${tag}`, kind: 'fixed', value: '100', currency: 'ETB', advertised: false } });
const offers = await call('GET', `/promotions/offers?supplierOrganizationId=${org.id}`);
check('public offers show the advertised one only', offers.status === 200 && offers.body.items.length === 1 && offers.body.items[0].code === `LAUNCH${tag}`, offers.body);
const order = await call('POST', '/purchase-orders', { ...B, headers: { 'idempotency-key': key() }, body: { supplierOrganizationId: org.id, currency: 'ETB', couponCode: `LAUNCH${tag}`, lines: [{ variantId: product.variants[0].id, quantity: '2' }] } });
check('buyer orders with the coupon', order.status === 201 && Number(order.body.discountTotal) > 0, order.body);
const savings = await call('GET', '/promotions/savings', B);
check('buyer sees savings', savings.body.items?.some((s) => s.orderId === order.body.id) && Number(savings.body.totals?.ETB) > 0, savings.body);
const perf = await call('GET', '/promotions/performance', O);
check('seller sees promotion performance', perf.body.some?.((p) => p.promotionId === promo.body.id && p.orders === 1), perf.body);

heading('Activity log');
const activity = await waitFor(async () => {
  const r = await call('GET', '/analytics/activity?area=sales', O);
  return r.body.items?.some((a) => a.reference === order.body.number) ? r : null;
});
check('order shows in the seller activity log', Boolean(activity), null);
const buyerLog = await call('GET', `/analytics/activity?q=${order.body.number}`, B);
check('…and the buyer’s, as their own action', buyerLog.body.items?.some((a) => a.own === true), buyerLog.body);
const facets = await call('GET', '/analytics/activity/facets', O);
check('activity facets by area', facets.body.areas?.some((a) => a.value === 'sales'), facets.body);
const filtered = await call('GET', '/analytics/activity?area=finance', O);
check('area filter applies', filtered.status === 200 && filtered.body.items.every((a) => a.area === 'finance'), filtered.body);
const isolated = await call('GET', `/analytics/activity?q=${order.body.number}`, { token: clerk.token, org: buyer.id });
check('other organizations cannot read it', isolated.status === 403 || isolated.status === 404, isolated.status);

heading('Admin audit filters');
const auditFacets = await call('GET', '/admin/audit/facets', { token: admin.token });
check('audit facets', auditFacets.status === 200 && Array.isArray(auditFacets.body.actions), auditFacets.body);
const action = auditFacets.body.actions?.[0]?.value;
const byAction = await call('GET', `/admin/audit?action=${action}&from=2020-01-01&to=2100-01-01`, { token: admin.token });
check('audit filtered by action and dates', byAction.status === 200 && byAction.body.items.every((e) => e.action === action), byAction.body);
const badRange = await call('GET', '/admin/audit?from=2026-02-01&to=2026-01-01', { token: admin.token });
check('reversed date range refused', badRange.status === 400, badRange.body);

heading('Report templates and store activity report');
const tpl = await call('POST', '/analytics/report-templates', { ...O, body: { name: 'Weekly store sales', dataset: 'sales_orders', columns: ['number', 'total'], filters: { period: 'last_7_days', branchId: bole.id }, format: 'xlsx' } });
check('template saved', tpl.status === 201 && tpl.body.format === 'xlsx', tpl.body);
const badTpl = await call('POST', '/analytics/report-templates', { ...O, body: { name: 'Bad', dataset: 'secrets', columns: ['x'], format: 'xlsx' } });
check('unknown dataset refused', badTpl.status === 400, badTpl.body);
const tpls = await call('GET', '/analytics/report-templates', O);
check('templates listed for the organization', tpls.body.some?.((t) => t.id === tpl.body.id), tpls.body);
const otherTpls = await call('GET', '/analytics/report-templates', B);
check("…and not for others", !otherTpls.body.some?.((t) => t.id === tpl.body.id), null);
const store = await call('POST', '/analytics/report-summary', { ...O, body: { branchId: bole.id } });
check('store activity report for one location', store.status === 200 && store.body.branchId === bole.id && Array.isArray(store.body.sources), store.body);

finish();
