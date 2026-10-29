// PRD Addendum v1.1 end to end: node scripts/smoke-addendum.mjs (stack running).
// Catalog types/media/tiers/options/price lists, server-side pricing, promotions, pickup,
// returns, refunds, online payments, reviews, claims, chat, entitlements, fleet,
// consolidated shipments, stock states, cycle counts, search, reports, summaries, role templates.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { adminSession, API, call, check, finish, heading, newUser, PNG, register, upload, waitFor } from './smoke-lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const admin = await adminSession(root, 'admin@uboce.local');
const tag = randomUUID().slice(0, 6).toUpperCase();
const key = () => `smoke-${randomUUID()}`;

heading('Setup');
const sOwner = await register(newUser('AddSupplier'));
const bOwner = await register(newUser('AddBuyer'));
const driverUser = await register(newUser('AddDriver'));
const junior = await register(newUser('AddJunior'));
const supplier = (await call('POST', '/organizations', { token: sOwner.token, body: { name: `Addendum Coffee ${tag}`, type: 'wholesaler', businessModels: ['wholesale', 'retail'] } })).body;
const buyer = (await call('POST', '/organizations', { token: bOwner.token, body: { name: `Addendum Cafe ${tag}`, type: 'business' } })).body;
check('organizations created', supplier.id && buyer.id, { supplier, buyer });
const S = { token: sOwner.token, org: supplier.id };
const B = { token: bOwner.token, org: buyer.id };

const pickup = await call('POST', `/organizations/${supplier.id}/branches`, {
  token: sOwner.token,
  body: { name: 'Bole pickup', kind: 'collection_point', city: 'Addis Ababa', pickupEnabled: true, serviceAreas: ['Addis Ababa', 'Adama'] },
});
check('pickup location', pickup.status === 201, pickup.body);

heading('Catalog: typed attributes, media, options, tiers, price lists');
const categories = (await call('GET', '/catalog/categories')).body;
const coffee = categories.find((c) => c.slug === 'coffee');
check('categories carry typed attributes', coffee.attributeDefinitions?.some((d) => d.key === 'grade' && d.type === 'enum'), coffee);

const bad = await call('POST', '/catalog/products', { ...S, body: { name: 'Bad grade', categoryId: coffee.id, unitOfMeasure: 'kg', attributes: { origin: 'Guji', grade: '9', process: 'washed' } } });
check('invalid attribute value rejected', bad.status === 400 && bad.body.error.code === 'invalid_attributes', bad.body);

const product = await call('POST', '/catalog/products', {
  ...S,
  body: {
    name: `Guji Natural ${tag}`,
    categoryId: coffee.id,
    unitOfMeasure: 'kg',
    attributes: { origin: 'Guji', grade: '1', process: 'natural', altitude_m: '2000' },
    leadTimeDays: 3,
    variants: [{ sku: `GUJ-${tag}`, name: 'Per kg', price: '500.00', currency: 'ETB', minOrderQuantity: '10', barcode: '1234567890123', packSize: '60' }],
  },
});
check('product created with barcode and pack size', product.status === 201 && product.body.variants[0].barcode === '1234567890123', product.body);
const productId = product.body.id;
const variantId = product.body.variants[0].id;

const tiers = await call('PUT', `/catalog/products/${productId}/variants/${variantId}/price-tiers`, { ...S, body: { tiers: [{ minQuantity: '100', unitPrice: '480.00' }, { minQuantity: '50', unitPrice: '490.00' }] } });
check('bulk tiers saved', tiers.status === 200 && tiers.body.variants[0].priceTiers.length === 2, tiers.body);
const risingTiers = await call('PUT', `/catalog/products/${productId}/variants/${variantId}/price-tiers`, { ...S, body: { tiers: [{ minQuantity: '100', unitPrice: '520.00' }] } });
check('tiers above list price rejected', risingTiers.status === 400, risingTiers.body);
await call('PUT', `/catalog/products/${productId}/variants/${variantId}/price-tiers`, { ...S, body: { tiers: [{ minQuantity: '100', unitPrice: '480.00' }, { minQuantity: '50', unitPrice: '490.00' }] } });

const options = await call('PUT', `/catalog/products/${productId}/options`, {
  ...S,
  body: { groups: [{ name: 'Packaging', required: true, options: [{ name: 'Jute bag', priceDelta: '0' }, { name: 'GrainPro liner', priceDelta: '35' }] }] },
});
check('option groups saved', options.status === 200 && options.body.optionGroups[0].options.length === 2, options.body);
const grainPro = options.body.optionGroups[0].options.find((o) => o.name === 'GrainPro liner').id;

const image = await upload(sOwner, supplier.id, { classification: 'product_image', fileName: 'bag.png', contentType: 'image/png', bytes: PNG() });
check('product image uploaded', image.status === 200, image.body);
const media = await call('PUT', `/catalog/products/${productId}/media`, { ...S, body: { items: [{ documentId: image.body.id, altText: 'Jute bag of green coffee' }] } });
check('media attached', media.status === 200 && media.body.media[0].documentId === image.body.id, media.body);
const publicImage = await fetch(`${API}/documents/public/${image.body.id}`, { redirect: 'manual' });
check('image publicly viewable (redirect to signed link)', publicImage.status === 302 && publicImage.headers.get('location'), publicImage.status);

const published = await call('POST', `/catalog/products/${productId}/publish`, S);
check('product published', published.status === 201 || published.status === 200, published.body);

const priceList = await call('POST', '/catalog/price-lists', {
  ...S,
  body: { name: 'Cafe partners', currency: 'ETB', buyerOrganizationIds: [buyer.id], entries: [{ variantId, unitPrice: '470.00', minQuantity: '0' }] },
});
check('price list for one buyer', priceList.status === 201, priceList.body);

heading('Server-side pricing, coupons and pickup orders');
const quote = await call('POST', '/catalog/price-check', { ...B, body: { supplierOrganizationId: supplier.id, currency: 'ETB', lines: [{ variantId, quantity: '60', optionIds: [grainPro] }] } });
check('buyer sees price list + option price', quote.status === 200 && quote.body.lines[0].unitPrice === '505' && quote.body.lines[0].priceSource === 'price_list', quote.body);
const belowMoq = await call('POST', '/catalog/price-check', { ...B, body: { supplierOrganizationId: supplier.id, currency: 'ETB', lines: [{ variantId, quantity: '5', optionIds: [grainPro] }] } });
check('below MOQ refused', belowMoq.status === 422 && belowMoq.body.error.code === 'below_moq', belowMoq.body);
const noOption = await call('POST', '/catalog/price-check', { ...B, body: { supplierOrganizationId: supplier.id, currency: 'ETB', lines: [{ variantId, quantity: '60' }] } });
check('required option enforced', noOption.status === 422 && noOption.body.error.code === 'option_required', noOption.body);

const policy = await call('POST', '/cancellation-policies', {
  ...S,
  body: { name: 'House terms', freeCancellationHours: 24, cancellationFeePct: '10', noShowFeePct: '5', returnWindowDays: 7, restockingFeePct: '10', pickupHoldHours: 1 },
});
check('cancellation policy published', policy.status === 201 && policy.body.version === 1, policy.body);
const coupon = await call('POST', '/promotions', { ...S, body: { name: 'Welcome', code: `WELCOME${tag}`, kind: 'percent', value: '10', currency: 'ETB', perBuyerLimit: 1 } });
check('coupon created', coupon.status === 201, coupon.body);
const couponCheck = await call('POST', '/promotions/check', { ...B, body: { supplierOrganizationId: supplier.id, currency: 'ETB', subtotal: '30300', couponCode: `welcome${tag}` } });
check('coupon preview', couponCheck.status === 200 && couponCheck.body.discount === '3030', couponCheck.body);

const order = await call('POST', '/purchase-orders', {
  ...B,
  headers: { 'idempotency-key': key() },
  body: {
    supplierOrganizationId: supplier.id,
    currency: 'ETB',
    fulfillmentMethod: 'pickup',
    fulfillmentBranchId: pickup.body.id,
    couponCode: `WELCOME${tag}`,
    lines: [{ variantId, quantity: '60', optionIds: [grainPro], unitPrice: '1.00' }],
  },
});
const o = order.body;
check('order priced by the catalog, not the buyer', order.status === 201 && o.lines[0].unitPrice === '505' && o.lines[0].priceSource === 'price_list', o);
check('coupon discount applied', o.subtotal === '30300' && o.discountTotal === '3030' && o.total === '27270', { subtotal: o.subtotal, discount: o.discountTotal, total: o.total });
check('product snapshot and policy kept on the order', o.lines[0].snapshot?.sku === `GUJ-${tag}` && o.lines[0].snapshot.options[0].name === 'GrainPro liner' && o.cancellationPolicy?.version === 1, o.lines[0].snapshot);
const reuse = await call('POST', '/purchase-orders', {
  ...B,
  headers: { 'idempotency-key': key() },
  body: { supplierOrganizationId: supplier.id, currency: 'ETB', couponCode: `WELCOME${tag}`, lines: [{ variantId, quantity: '60', optionIds: [grainPro] }] },
});
check('coupon per-buyer limit', reuse.status === 400 && reuse.body.error.code === 'coupon_used_up', reuse.body);

for (const step of ['confirm', 'ready-for-pickup']) {
  const r = await call('POST', `/sales-orders/${o.id}/${step}`, S);
  check(`supplier: ${step}`, r.status === 201 || r.status === 200, r.body);
}
const early = await call('POST', `/sales-orders/${o.id}/uncollected`, { ...S, body: {} });
check('no-show not before the hold time', early.status === 409 && early.body.error.code === 'pickup_hold', early.body);
const collected = await call('POST', `/sales-orders/${o.id}/collected`, S);
check('pickup collected → fulfilled', collected.body.status === 'fulfilled' && collected.body.lines[0].fulfilledQuantity === '60', collected.body.status);

heading('Invoices with discounts, online payment');
const invoice = await call('POST', '/invoices/from-order', { ...S, body: { orderId: o.id, taxRatePct: '0', dueInDays: 14 } });
check('invoice includes the discount line', invoice.status === 201 && invoice.body.total === '27270' && invoice.body.lines.some((l) => l.description.startsWith('Discount')), invoice.body);
await call('POST', `/invoices/${invoice.body.id}/issue`, S);
const providers = await call('GET', '/payments/providers', { token: bOwner.token });
check('payment providers listed', providers.body.some((p) => p.name === 'sandbox'), providers.body);
const intent = await call('POST', `/invoices/${invoice.body.id}/pay`, { ...B, body: { provider: 'sandbox' } });
check('payment intent with checkout link', intent.status === 201 && intent.body.checkoutUrl?.includes('/pay/sandbox'), intent.body);
const paid = await call('POST', `/payments/intents/${intent.body.id}/sandbox`, { ...B, body: { outcome: 'succeeded' } });
check('sandbox payment succeeded with fee', paid.body.status === 'succeeded' && Number(paid.body.fee) > 0, paid.body);
const paidInvoice = await call('GET', `/invoices/${invoice.body.id}`, S);
check('invoice paid', paidInvoice.body.status === 'paid', paidInvoice.body.status);

heading('Returns and refunds');
const ret = await call('POST', `/purchase-orders/${o.id}/returns`, { ...B, body: { reason: 'Two bags arrived wet', lines: [{ orderLineId: o.lines[0].id, quantity: '2' }] } });
check('return requested', ret.status === 201 && ret.body.amount === '1010' && ret.body.restockingFee === '101', ret.body);
const tooMany = await call('POST', `/purchase-orders/${o.id}/returns`, { ...B, body: { reason: 'Everything else', lines: [{ orderLineId: o.lines[0].id, quantity: '59' }] } });
check('cannot return more than delivered', tooMany.status === 400 && tooMany.body.error.code === 'over_return', tooMany.body);
await call('POST', `/returns/${ret.body.id}/decision`, { ...S, body: { decision: 'approve' } });
const received = await call('POST', `/returns/${ret.body.id}/receive`, S);
check('return received', received.body.status === 'received', received.body);
const refund = await waitFor(async () => (await call('GET', '/refunds?side=seller', S)).body.items?.find((r) => r.returnId === ret.body.id));
check('refund requested for the return', refund && refund.amount === '909' && refund.invoiceId === invoice.body.id, refund);
const approved = await call('POST', `/refunds/${refund.id}/approve`, { ...S, body: { method: 'provider' } });
check('refund through the sandbox provider succeeded', approved.body.status === 'succeeded', approved.body);
const afterRefund = await call('GET', `/invoices/${invoice.body.id}`, S);
check('invoice credited and paid amount reduced', afterRefund.body.creditedAmount === '909' && afterRefund.body.paidAmount === '26361' && afterRefund.body.status === 'paid', {
  credited: afterRefund.body.creditedAmount,
  paid: afterRefund.body.paidAmount,
  status: afterRefund.body.status,
});

heading('Reviews, claims, chat');
const review = await call('POST', '/quality/reviews', { ...B, body: { orderId: o.id, rating: 4, title: 'Good beans', body: 'Clean cup, two wet bags.' } });
check('verified review published', review.status === 201 && review.body.status === 'published', review.body);
const dup = await call('POST', '/quality/reviews', { ...B, body: { orderId: o.id, rating: 5 } });
check('one review per order', dup.status === 409, dup.body);
const held = await call('POST', '/quality/reviews', { ...B, body: { orderId: o.id, productId, rating: 5, body: 'Call me on +251 911 223344' } });
check('reviews with contact details are held', held.body.status === 'pending', held.body);
const ratings = await call('GET', `/quality/ratings?ids=${supplier.id}`);
check('public rating', ratings.body[0]?.average === 4, ratings.body);
const reply = await call('POST', `/quality/reviews/${review.body.id}/reply`, { ...S, body: { reply: 'Thanks — replacement bags are on us.' } });
check('supplier replies', reply.body.supplierReply?.startsWith('Thanks'), reply.body);
const claim = await call('POST', '/quality/claims', { ...B, body: { orderId: o.id, orderLineId: o.lines[0].id, reason: 'moisture', description: 'Two bags measured 14% moisture on arrival', affectedQuantity: '2' } });
check('quality claim opened', claim.status === 201 && claim.body.number.startsWith('QC-'), claim.body);
const answer = await call('POST', `/quality/claims/${claim.body.id}/response`, { ...S, body: { decision: 'accept', resolution: 'replacement', response: 'We will replace both bags.' } });
check('supplier accepts the claim', answer.body.status === 'accepted', answer.body);

const convo = await call('POST', '/conversations', { ...B, body: { subject: `Order ${o.number}`, contextType: 'order', contextId: o.id, participantOrganizationIds: [supplier.id], message: 'When can we collect the replacement?' } });
check('buyer starts an order conversation', convo.status === 201, convo.body);
const unread = await call('GET', '/conversations/unread', S);
check('supplier has an unread message', unread.body.unread === 1, unread.body);
await call('POST', `/conversations/${convo.body.id}/messages`, { ...S, body: { body: 'Tomorrow after 10:00.' } });
const thread = await call('GET', `/conversations/${convo.body.id}/messages`, B);
check('both messages in the thread', thread.body.length === 2, thread.body);
const outsider = await call('POST', '/conversations', { token: junior.token, org: buyer.id, body: { subject: 'x', contextType: 'general', participantOrganizationIds: [supplier.id], message: 'hi' } });
check('non-members cannot chat for the organization', outsider.status === 404, outsider.body);

heading('Entitlements and fleet');
const ent = await call('GET', '/admin/entitlements/me', S);
check('fleet is off by default', ent.body.modules.fleet === false && ent.body.modules.catalog === true, ent.body.modules);
const blocked = await call('GET', '/fleet', S);
check('disabled module refused', blocked.status === 403 && blocked.body.error.code === 'module_not_enabled', blocked.body);
const enable = await call('PUT', `/admin/organizations/${supplier.id}/entitlements/fleet`, { token: admin.token, body: { enabled: true, reasonCode: 'pilot_rollout', reason: 'Smoke test pilot' } });
check('admin enables fleet', enable.status === 200, enable.body);
await new Promise((r) => setTimeout(r, 31_000)); // entitlement cache in each service
const fleet = await call('GET', '/fleet', S);
check('fleet available after enabling', fleet.status === 200, fleet.body);

await call('POST', `/organizations/${supplier.id}/members`, { token: sOwner.token, body: { userId: driverUser.id, role: 'driver' } });
const vehicle = await call('POST', '/fleet/vehicles', { ...S, body: { plateNumber: `AA-${tag}`, type: 'truck', capacityKg: '5000' } });
const driver = await call('POST', '/fleet/drivers', { ...S, body: { name: 'Abebe Driver', phone: '+251911000111', userId: driverUser.id } });
check('vehicle and driver registered', vehicle.status === 201 && driver.status === 201, { vehicle: vehicle.body, driver: driver.body });

heading('Consolidated shipment with a driver');
const deliveryOrders = [];
for (const qty of ['20', '30']) {
  const r = await call('POST', '/purchase-orders', { ...B, headers: { 'idempotency-key': key() }, body: { supplierOrganizationId: supplier.id, currency: 'ETB', lines: [{ variantId, quantity: qty, optionIds: [grainPro] }] } });
  await call('POST', `/sales-orders/${r.body.id}/confirm`, S);
  deliveryOrders.push(r.body);
}
const shipment = await call('POST', '/shipments', {
  ...S,
  body: {
    orderId: deliveryOrders[0].id,
    freightPayer: 'consignee',
    incoterm: 'DAP',
    items: deliveryOrders.map((d) => ({ orderId: d.id, orderLineId: d.lines[0].id, quantity: d.lines[0].quantity })),
  },
});
check('one shipment carries two orders', shipment.status === 201 && shipment.body.orders.length === 2 && shipment.body.freightPayer === 'consignee', shipment.body);
const sid = shipment.body.id;
await call('PUT', `/shipments/${sid}/packages`, { ...S, body: { packages: [{ reference: 'PKG-1', weightKg: '1200' }, { reference: 'PKG-2', weightKg: '1800' }] } });
const assigned = await call('POST', `/shipments/${sid}/assign`, { ...S, body: { driverId: driver.body.id, vehicleId: vehicle.body.id } });
check('driver assigned', assigned.body.status === 'assigned', assigned.body.status);
await call('POST', `/shipments/${sid}/dispatch`, S);
const D = { token: driverUser.token, org: supplier.id };
const mine = await call('GET', '/shipments/driver/assignments', D);
check('driver sees only their assignment', mine.body.items?.length === 1 && mine.body.items[0].shipmentId === sid, mine.body);
const notMine = await call('GET', '/shipments?direction=outbound', D);
check('driver cannot list all shipments', notMine.status === 403, notMine.body);
for (const status of ['picked_up', 'delayed', 'in_transit']) {
  const r = await call('POST', `/shipments/${sid}/driver-updates`, { ...D, body: { status, location: 'Mojo' } });
  check(`driver: ${status}`, r.body.status === status, r.body);
}
const confirm = await call('POST', `/shipments/${sid}/confirm-delivery`, {
  ...B,
  body: { recipientName: 'Cafe manager', items: deliveryOrders.map((d) => ({ orderLineId: d.lines[0].id, deliveredQuantity: d.lines[0].quantity })) },
});
check('delivery confirmed', confirm.body.status === 'delivered', confirm.body.status);
const bothFulfilled = await waitFor(async () => {
  const states = await Promise.all(deliveryOrders.map(async (d) => (await call('GET', `/purchase-orders/${d.id}`, B)).body.status));
  return states.every((s) => s === 'fulfilled') && states;
});
check('both orders fulfilled from one delivery', bothFulfilled, bothFulfilled);

heading('Stock states and cycle counts');
const wh = await call('POST', '/warehouse/warehouses', { ...S, body: { code: `ST-${tag}`.slice(0, 20), name: 'Smoke store', branchId: pickup.body.id } });
const adj = await call('POST', '/inventory/adjustments', { ...S, headers: { 'idempotency-key': key() }, body: { warehouseId: wh.body.id, itemId: productId, quantity: '100', reasonCode: 'opening_balance' } });
check('opening stock', adj.status === 201, adj.body);
const damaged = await call('POST', '/inventory/state-changes', { ...S, body: { warehouseId: wh.body.id, itemId: productId, from: 'available', to: 'damaged', quantity: '10', reason: 'Torn bags' } });
check('stock marked damaged', damaged.status === 201, damaged.body);
const balance = (await call('GET', `/inventory/balances?itemId=${productId}`, S)).body.items[0];
check('damaged stock is not available', balance.available === '90' && balance.damaged === '10', balance);
const writeOff = await call('POST', '/inventory/write-offs', { ...S, body: { warehouseId: wh.body.id, itemId: productId, quantity: '4', reason: 'Beyond repair' } });
check('write-off', writeOff.status === 201, writeOff.body);
const count = await call('POST', '/inventory/cycle-counts', { ...S, body: { warehouseId: wh.body.id } });
check('cycle count started with expected quantities', count.status === 201 && count.body.lines[0].expectedQuantity === '96', count.body);
await call('POST', `/inventory/cycle-counts/${count.body.id}/lines`, { ...S, body: { lines: [{ itemId: productId, countedQuantity: '94' }] } });
await call('POST', `/inventory/cycle-counts/${count.body.id}/submit`, S);
const selfApprove = await call('POST', `/inventory/cycle-counts/${count.body.id}/approve`, S);
check('counter cannot approve their own count', selfApprove.status === 403, selfApprove.body);

heading('Search: typos, synonyms, filters, facets');
const typo = await waitFor(async () => {
  const r = await call('GET', `/discovery/products?q=guji%20naturl&facets=true`);
  return r.body.items?.some((p) => p.productId === productId) && r;
}, 30_000);
check('typo-tolerant search finds the product', typo, null);
check('facets returned', typo && typo.body.facets?.categories?.length > 0 && typo.body.facets.attributes?.grade, typo?.body?.facets);
const syn = await call('GET', `/discovery/products?q=buna&supplierId=${supplier.id}`);
check('synonym (buna → coffee) matches', syn.body.items?.some((p) => p.productId === productId), syn.body.items?.length);
const area = await call('GET', `/discovery/products?deliversTo=adama&supplierId=${supplier.id}`);
check('delivery-area filter', area.body.items?.length >= 1, area.body);
const moq = await call('GET', `/discovery/products?maxMoq=5&supplierId=${supplier.id}`);
check('MOQ filter excludes it', moq.body.items?.length === 0, moq.body.items);
const rated = await waitFor(async () => (await call('GET', `/discovery/products?minRating=4&supplierId=${supplier.id}`)).body.items?.length >= 1);
check('rating filter', rated, null);
const stocked = await waitFor(async () => (await call('GET', `/discovery/products?inStock=true&supplierId=${supplier.id}`)).body.items?.length >= 1);
check('in-stock filter', stocked, null);

heading('Reports and report summaries');
const report = await call('GET', '/sales-orders/reports/locations', S);
const loc = report.body.locations?.find((l) => l.branchId === pickup.body.id);
check('location report', report.status === 200 && loc?.orders >= 1 && loc.returns === 1, report.body);
const aiDefault = await call('POST', '/analytics/report-summary', { ...S, body: {} });
check('report summaries are on by default', aiDefault.status === 200, aiDefault.body);
await call('PUT', `/admin/organizations/${supplier.id}/entitlements/report_summaries`, { token: admin.token, body: { enabled: true, reasonCode: 'pilot_rollout', reason: 'Smoke test pilot' } });
await new Promise((r) => setTimeout(r, 31_000));
const ai = await call('POST', '/analytics/report-summary', { ...S, body: {} });
const cited = ai.body.summary && [...ai.body.summary.highlights, ...ai.body.summary.concerns, ...ai.body.summary.suggestions].every((p) => p.sourceIds.every((id) => ai.body.sources.some((s) => s.id === id)));
check('summary with valid citations', ai.status === 200 && ai.body.sources.length > 0 && cited, ai.body.summary);

heading('Role templates and approval limits');
const template = await call('POST', `/organizations/${buyer.id}/role-templates`, {
  token: bOwner.token,
  body: { name: 'Junior buyer', permissions: ['purchase_orders:approve', 'rfqs:manage'], approvalLimit: '10000', approvalCurrency: 'ETB' },
});
check('role template created', template.status === 201, template.body);
const member = await call('POST', `/organizations/${buyer.id}/members`, { token: bOwner.token, body: { userId: junior.id, role: 'procurement_officer' } });
await call('PUT', `/organizations/${buyer.id}/members/${member.body.id}/template`, { token: bOwner.token, body: { roleTemplateId: template.body.id } });
const J = { token: junior.token, org: buyer.id };
const big = await call('POST', '/purchase-orders', { ...J, headers: { 'idempotency-key': key() }, body: { supplierOrganizationId: supplier.id, currency: 'ETB', lines: [{ variantId, quantity: '30', optionIds: [grainPro] }] } });
check('over the approval limit refused', big.status === 403 && big.body.error.code === 'approval_limit_exceeded', big.body);
const small = await call('POST', '/purchase-orders', { ...J, headers: { 'idempotency-key': key() }, body: { supplierOrganizationId: supplier.id, currency: 'ETB', lines: [{ variantId, quantity: '15', optionIds: [grainPro] }] } });
check('within the limit allowed', small.status === 201, small.body);

finish();
