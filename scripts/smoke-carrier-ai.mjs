// Supplier ↔ logistics provider hand-off, admin business-type modules and the Groq assistant.
// node scripts/smoke-carrier-ai.mjs (stack running; Groq checks are skipped when it isn't configured).
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { adminSession, call, check, finish, heading, newUser, register, waitFor } from './smoke-lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const admin = await adminSession(root, 'admin@uboce.local');
const tag = randomUUID().slice(0, 6).toUpperCase();
const key = () => `smoke-${randomUUID()}`;

heading('Setup: supplier, buyer, logistics provider');
const [sup, buy, log, drv] = await Promise.all(['CarSupplier', 'CarBuyer', 'CarLogistics', 'CarDriver'].map((n) => register(newUser(n))));
const org = async (u, name, type) => (await call('POST', '/organizations', { token: u.token, body: { name, type } })).body;
const supplier = await org(sup, `Hand-off Coffee ${tag}`, 'wholesaler');
const buyer = await org(buy, `Hand-off Cafe ${tag}`, 'business');
const logistics = await org(log, `Fast Freight ${tag}`, 'logistics_provider');
const S = { token: sup.token, org: supplier.id };
const B = { token: buy.token, org: buyer.id };
const L = { token: log.token, org: logistics.id };
await call('POST', `/organizations/${logistics.id}/branches`, { token: log.token, body: { name: 'Addis depot', kind: 'warehouse', city: 'Addis Ababa', serviceAreas: ['Addis Ababa', 'Adama'] } });

const providers = await call('GET', `/organizations/providers?type=logistics_provider&q=${encodeURIComponent(`Fast Freight ${tag}`)}`, { token: sup.token });
check('supplier finds the logistics provider', providers.body.some?.((p) => p.id === logistics.id && p.serviceAreas.includes('Adama')), providers.body);

heading('Business types drive modules');
const ent = await call('GET', '/admin/entitlements/me', L);
check('logistics providers get fleet by default', ent.body.modules?.fleet === true && ent.body.modules?.agriculture === false, ent.body.modules);
const grid = await call('GET', '/admin/business-types', { token: admin.token });
check('admin sees the business-type grid', grid.status === 200 && grid.body.matrix.logistics_provider.fleet.enabled === true, grid.status);
const setType = await call('PUT', '/admin/business-types/wholesaler/modules/fleet', { token: admin.token, body: { enabled: true, reasonCode: 'smoke_test', reason: 'Wholesalers run their own trucks' } });
check('admin turns fleet on for wholesalers', setType.status === 200 && setType.body.enabled === true, setType.body);
const supEnt = await call('GET', '/admin/entitlements/me', S);
check('wholesaler now has fleet', supEnt.body.modules?.fleet === true, supEnt.body.modules);
await call('PUT', '/admin/business-types/wholesaler/modules/fleet', { token: admin.token, body: { enabled: null, reasonCode: 'smoke_test', reason: 'Back to default' } });

heading('Shipment handed to the logistics provider');
const cat = (await call('GET', '/catalog/categories')).body.find((c) => c.slug === 'general');
const p = (await call('POST', '/catalog/products', { ...S, body: { name: `Sacks ${tag}`, categoryId: cat.id, unitOfMeasure: 'piece', variants: [{ sku: `SK-${tag}`, name: 'Each', price: '30.00', currency: 'ETB' }] } })).body;
await call('POST', `/catalog/products/${p.id}/publish`, S);
const order = (await call('POST', '/purchase-orders', { ...B, headers: { 'idempotency-key': key() }, body: { supplierOrganizationId: supplier.id, currency: 'ETB', lines: [{ variantId: p.variants[0].id, quantity: '100' }] } })).body;
await call('POST', `/sales-orders/${order.id}/confirm`, S);
const ship = await call('POST', '/shipments', { ...S, body: { orderId: order.id, carrierOrganizationId: logistics.id, items: [{ orderLineId: order.lines[0].id, quantity: '100' }] } });
check('shipment names the carrier', ship.status === 201 && ship.body.carrierStatus === 'requested', ship.body);
const sid = ship.body.id;
const toCarry = await call('GET', '/shipments?direction=carrier', L);
check('carrier sees the request', toCarry.body.items?.some((x) => x.id === sid), toCarry.body);
const early = await call('POST', `/shipments/${sid}/tracking`, { ...L, body: { status: 'in_transit' } });
check('carrier cannot track before accepting', early.status === 409, early.body);
const accept = await call('POST', `/shipments/${sid}/carrier-response`, { ...L, body: { decision: 'accept', note: 'Truck ready Thursday' } });
check('carrier accepts', accept.body.carrierStatus === 'accepted', accept.body);

await call('POST', `/organizations/${logistics.id}/members`, { token: log.token, body: { userId: drv.id, role: 'driver' } });
const driver = await call('POST', '/fleet/drivers', { ...L, body: { name: 'Carrier Driver', phone: '+251911555666', userId: drv.id } });
const assign = await call('POST', `/shipments/${sid}/assign`, { ...L, body: { driverId: driver.body.id } });
check('carrier assigns its own driver', assign.status === 201 && assign.body.assignments?.[0]?.driverId === driver.body.id, assign.body);
await call('POST', `/shipments/${sid}/dispatch`, S);
const D = { token: drv.token, org: logistics.id };
const picked = await call('POST', `/shipments/${sid}/driver-updates`, { ...D, body: { status: 'picked_up', location: 'Supplier warehouse' } });
check("carrier's driver updates the shipment", picked.body.status === 'picked_up', picked.body);
const tracked = await call('POST', `/shipments/${sid}/tracking`, { ...L, body: { status: 'in_transit', location: 'Mojo' } });
check('carrier posts tracking', tracked.body.status === 'in_transit', tracked.body);

heading('Three-way shipment chat');
const convo = await call('POST', '/conversations', { ...S, body: { subject: `Shipment ${order.number}`, contextType: 'shipment', contextId: sid, participantOrganizationIds: [logistics.id, buyer.id], message: 'Please call the buyer before arrival.' } });
check('supplier messages carrier and buyer', convo.status === 201 && convo.body.participants.length === 3, convo.body);
const reply = await call('POST', `/conversations/${convo.body.id}/messages`, { ...L, body: { body: 'Will do — ETA 15:00.' } });
check('carrier replies', reply.status === 201, reply.body);
const outsider = await register(newUser('CarOutsider'));
const outOrg = await org(outsider, `Other Freight ${tag}`, 'logistics_provider');
const sneaky = await call('POST', '/conversations', { token: outsider.token, org: outOrg.id, body: { subject: 'Join us', contextType: 'shipment', contextId: sid, participantOrganizationIds: [supplier.id], message: 'hi' } });
check('other providers cannot join the shipment chat', sneaky.status === 404, sneaky.body);
const notified = await waitFor(async () => (await call('GET', '/notifications', { token: log.token })).body.items?.some((n) => n.title?.includes('carry') || n.templateKey === 'carrier_request'));
check('carrier was notified of the request', notified, null);

heading('Groq assistant');
const status = await call('GET', '/rfqs/assist/status', B);
if (!status.body?.enabled) {
  console.log('  (Groq not configured; skipping)');
} else {
  const draft = await call('POST', '/rfqs/assist', { ...B, body: { prompt: 'We need 2 tonnes of washed grade 1 Sidama coffee, moisture below 11.5%, delivered to Bole within a month, and 500 jute bags.' } });
  check('RFQ drafted from a description', draft.status === 200 && draft.body.lines?.length >= 2 && draft.body.lines.some((l) => l.unitOfMeasure === 'tonne' || l.unitOfMeasure === 'kg'), draft.body);
  const desc = await call('POST', `/catalog/products/${p.id}/assist/description`, S);
  check('product description suggested', desc.status === 200 && desc.body.description?.length > 20, desc.body);
  const sum = await call('POST', '/analytics/report-summary', { ...S, body: {} });
  check('report summary (on by default, with sources)', sum.status === 200 && Array.isArray(sum.body.sources), sum.body);
}

finish();
