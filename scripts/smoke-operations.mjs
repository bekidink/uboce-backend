// End-to-end smoke test for PRD Stages 3–6, through the gateway:
// platform admin & staff, documents, KYC/KYB, warehouse & inventory (incl.
// concurrency), fulfilment, carrier and payment webhooks, invoicing,
// disputes & performance, agriculture lineage, manufacturing, analytics.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  adminSession,
  call,
  check,
  finish,
  heading,
  inDays,
  newUser,
  PDF,
  PNG,
  register,
  signCallback,
  upload,
  waitFor,
} from './smoke-lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const envOf = (path) => Object.fromEntries([...readFileSync(`${root}${path}`, 'utf8').matchAll(/^([A-Z0-9_]+)=(.*)$/gm)].map((m) => [m[1], m[2]]));
const providerSecret = (name) => envOf('services/integration/.env').PROVIDERS.split(',').find((p) => p.startsWith(`${name}:`)).split(':')[2];

// =============================================================================
heading('Platform administration (bootstrap admin with MFA)');
const ADMIN_EMAIL = envOf('services/administration/.env').ADMIN_BOOTSTRAP_EMAILS.split(',')[0];
const admin = await adminSession(root, ADMIN_EMAIL);
let r = await call('GET', '/admin/me', { token: admin.token });
check('bootstrap admin (verified email + MFA) is platform_admin', r.body.roles?.includes('platform_admin'), r.body);

const sam = await register(newUser('Sam'));
const bea = await register(newUser('Bea'));
const eve = await register(newUser('Eve'));
const org = async (user, name, type) => (await call('POST', '/organizations', { token: user.token, body: { name, type } })).body.id;
const supplier = await org(sam, `Yirga Processing ${randomUUID().slice(0, 4)}`, 'cooperative');
const buyer = await org(bea, `Habesha Foods ${randomUUID().slice(0, 4)}`, 'business');
const outsider = await org(eve, 'Outsider Trading', 'wholesaler');

r = await call('GET', '/admin/staff', { token: sam.token });
check('ordinary users cannot use admin tools', r.status === 403, r);
r = await call('PUT', '/admin/feature-flags/procurement.reverse_auction', {
  token: admin.token,
  body: { enabled: false, organizationIds: [supplier], reasonCode: 'pilot_rollout', reason: 'Pilot with one cooperative' },
});
check('admin sets a pilot feature flag (with reason code)', r.status === 200, r);
r = await call('GET', '/admin/feature-flags/evaluate', { token: sam.token, org: supplier });
const r2 = await call('GET', '/admin/feature-flags/evaluate', { token: bea.token, org: buyer });
check('the flag is on only for the pilot organization', r.body['procurement.reverse_auction'] === true && r2.body['procurement.reverse_auction'] === false, [r.body, r2.body]);
r = await call('POST', '/admin/staff', { token: admin.token, body: { userId: bea.id, role: 'verification_reviewer', reasonCode: 'staffing', reason: 'Temporary reviewer' } });
const grantId = r.body.id;
r = await call('GET', '/admin/me', { token: bea.token });
check('staff roles stay inactive until the account has MFA', r.body.roles?.length === 0 && r.body.blockedReason === 'mfa_required', r.body);
r = await call('GET', '/kyc/review/cases', { token: bea.token });
check('…so a reviewer without MFA is refused', r.status === 403, r);
await call('DELETE', `/admin/staff/${grantId}`, { token: admin.token, body: { reasonCode: 'staffing', reason: 'No longer needed' } });
r = await call('GET', '/admin/audit?targetType=feature_flag', { token: admin.token });
check('admin actions are audited with before/after', r.body.items?.[0]?.reasonCode === 'pilot_rollout' && 'after' in (r.body.items?.[0]?.details ?? {}), r.body.items?.[0]);

// =============================================================================
heading('Documents (private storage, signed links, content checks, retention)');
const doc = async (user, orgId, classification, name = classification) =>
  (await upload(user, orgId, { classification, fileName: `${name}.pdf`, contentType: 'application/pdf', bytes: PDF(name) })).body;
const registration = await doc(sam, supplier, 'business_registration');
check('upload via signed URL, verified with SHA-256', registration?.status === 'available' && /^[0-9a-f]{64}$/.test(registration.sha256 ?? ''), registration);
r = await upload(sam, supplier, { classification: 'other', fileName: 'invoice.pdf', contentType: 'application/pdf', bytes: Buffer.from('MZ\x90\x00 not a pdf at all') });
check('a file that is not what it claims is rejected and erased', r.body?.status === 'rejected', r.body);
r = await call('GET', `/documents/${registration.id}`, { token: bea.token, org: buyer });
check("other organizations can't see private documents", r.status === 404, r);
r = await call('GET', `/documents/${registration.id}/download-url`, { token: sam.token, org: supplier });
const bytes = r.status === 200 ? Buffer.from(await (await fetch(r.body.url)).arrayBuffer()) : null;
check('owners download through a short-lived signed link', bytes?.toString('latin1').startsWith('%PDF-'), r);
r = await call('DELETE', `/documents/${registration.id}`, { token: sam.token, org: supplier });
check('regulated documents are kept for their retention period', r.status === 409 && r.body.error.code === 'retention_period', r);

// =============================================================================
heading('Business verification (KYB) and individual verification (KYC)');
const license = await doc(sam, supplier, 'license');
const tax = await doc(sam, supplier, 'tax_certificate');
const repId = await doc(sam, supplier, 'identity_document', 'representative_id');
r = await call('POST', '/kyb/cases', { token: sam.token, org: supplier, body: { tier: 'standard' } });
const kyb = r.body;
check('the organization opens a KYB case', r.status === 201 && kyb.nextAction?.startsWith('Upload'), r);
r = await call('POST', `/kyb/cases/${kyb.id}/evidence`, { token: sam.token, org: supplier, body: { requirement: 'trade_license', documentId: tax.id } });
check('evidence must be the right kind of document', r.status === 400 && r.body.error.code === 'wrong_document_type', r);
for (const [requirement, d] of [['business_registration', registration], ['trade_license', license], ['tax_registration', tax], ['representative_id', repId]]) {
  await call('POST', `/kyb/cases/${kyb.id}/evidence`, { token: sam.token, org: supplier, body: { requirement, documentId: d.id } });
}
r = await call('POST', `/kyb/cases/${kyb.id}/submit`, { token: sam.token, org: supplier });
check('submitted with all evidence', r.body.status === 'submitted', r);
r = await call('GET', '/kyb/review/cases?status=submitted', { token: admin.token });
check('the case appears in the review queue', r.body.items?.some((c) => c.id === kyb.id), r.body.meta);
await call('POST', `/kyb/review/cases/${kyb.id}/claim`, { token: admin.token });
r = await call('GET', `/documents/${license.id}/download-url`, { token: admin.token });
check('reviewers can read evidence attached to a case', r.status === 200, r);
r = await call('GET', `/documents/${license.id}/download-url`, { token: bea.token, org: buyer });
check('…nobody else can', r.status === 404, r);
await call('POST', `/kyb/review/cases/${kyb.id}/checks`, { token: admin.token, body: { type: 'registry_lookup', result: 'pass', details: 'Matches the trade registry' } });
r = await call('POST', `/kyb/review/cases/${kyb.id}/decision`, { token: admin.token, body: { decision: 'approved', reasonCode: 'all_checks_passed', notes: 'internal note' } });
check('the reviewer approves', r.body.status === 'approved' && !!r.body.expiresAt, r.body);
r = await call('GET', '/kyb/cases', { token: sam.token, org: supplier });
check('the organization sees the outcome, not reviewer notes', r.body[0]?.status === 'approved' && JSON.stringify(r.body).includes('internal note') === false, r.body);
const verified = await waitFor(async () => (await call('GET', `/organizations/${supplier}`, { token: sam.token })).body.verificationStatus === 'verified');
check('Organization picks up the KYB decision (verified)', !!verified);

const nationalId = (await upload(bea, undefined, { classification: 'identity_document', fileName: 'id.pdf', contentType: 'application/pdf', bytes: PDF('national id') })).body;
r = await call('POST', '/kyc/cases', { token: bea.token, body: { tier: 'basic' } });
const kyc = r.body;
await call('POST', `/kyc/cases/${kyc.id}/evidence`, { token: bea.token, body: { requirement: 'national_id', documentId: nationalId.id } });
await call('POST', `/kyc/cases/${kyc.id}/submit`, { token: bea.token });
await call('POST', `/kyc/review/cases/${kyc.id}/claim`, { token: admin.token });
await call('POST', `/kyc/review/cases/${kyc.id}/decision`, { token: admin.token, body: { decision: 'approved', reasonCode: 'id_verified' } });
r = await call('GET', '/kyc/cases', { token: bea.token });
check('KYC: an individual is verified end to end', r.body[0]?.status === 'approved', r.body);
const kycNote = await waitFor(async () => (await call('GET', '/notifications', { token: bea.token })).body.items?.find((n) => n.templateKey === 'verification_update'));
check('…and notified', !!kycNote);

// =============================================================================
heading('Warehouse & inventory');
const wh = async (code) => (await call('POST', '/warehouse/warehouses', { token: sam.token, org: supplier, body: { code, name: `Warehouse ${code}`, city: 'Hawassa' } })).body.id;
const whA = await wh('HWS-A');
const whB = await wh('HWS-B');
const coffee = (await call('GET', '/catalog/categories')).body.find((c) => c.slug === 'coffee');
const general = (await call('GET', '/catalog/categories')).body.find((c) => c.slug === 'general');
const product = async (name, category, attributes, price) => {
  const p = (await call('POST', '/catalog/products', { token: sam.token, org: supplier, body: { name, categoryId: category.id, unitOfMeasure: 'kg', attributes, variants: [{ sku: `SKU-${randomUUID().slice(0, 8)}`, name: '1 kg', price, currency: 'ETB' }] } })).body;
  await call('POST', `/catalog/products/${p.id}/publish`, { token: sam.token, org: supplier });
  variantOf[p.id] = p.variants[0].id;
  return p.id;
};
const variantOf = {};
const green = await product('Yirgacheffe green coffee', coffee, { origin: 'Yirgacheffe', grade: '1', process: 'washed' }, '420.00');
const roasted = await product('Yirgacheffe roasted coffee', general, {}, '900.00');

const balance = async (itemId, warehouseId) => {
  const b = await call('GET', `/inventory/balances?itemId=${itemId}${warehouseId ? `&warehouseId=${warehouseId}` : ''}`, { token: sam.token, org: supplier });
  return b.body.items?.reduce((s, x) => ({ onHand: s.onHand + Number(x.onHand), reserved: s.reserved + Number(x.reserved) }), { onHand: 0, reserved: 0 });
};
r = await call('POST', '/warehouse/receipts', {
  token: sam.token,
  org: supplier,
  body: { warehouseId: whA, inspectionRequired: false, lines: [{ itemId: green, description: 'Green coffee', expectedQuantity: '1000', receivedQuantity: '1000', rejectedQuantity: '0' }] },
});
check('a receipt posts stock through Inventory', r.body.status === 'posted', r);
check('balance shows 1000 on hand', (await balance(green, whA))?.onHand === 1000, await balance(green, whA));

r = await call('POST', '/warehouse/receipts', {
  token: sam.token,
  org: supplier,
  body: { warehouseId: whA, inspectionRequired: true, lines: [{ itemId: green, description: 'Second delivery', receivedQuantity: '22', rejectedQuantity: '2', discrepancyNote: 'two torn bags' }] },
});
const heldReceipt = r.body;
check('an inspected receipt is held (partial, with dock rejections)', heldReceipt.status === 'pending_inspection' && (await balance(green, whA))?.onHand === 1000, heldReceipt);
const inspection = await waitFor(async () => (await call('GET', '/quality/inspections?status=pending', { token: sam.token, org: supplier })).body.items?.find((i) => i.subjectId === heldReceipt.id));
check('Quality opens an inspection for it automatically', inspection?.lines?.[0]?.inspectedQuantity === '20', inspection);
r = await call('POST', `/quality/inspections/${inspection.id}/results`, {
  token: sam.token,
  org: supplier,
  body: { decision: 'accepted', lines: [{ itemId: green, acceptedQuantity: '15', rejectedQuantity: '5' }] },
});
check('inconsistent decisions are refused', r.status === 422, r);
r = await call('POST', `/quality/inspections/${inspection.id}/results`, {
  token: sam.token,
  org: supplier,
  body: { decision: 'conditionally_accepted', lines: [{ itemId: green, acceptedQuantity: '15', rejectedQuantity: '5' }], nonconformances: [{ description: 'Moisture above 12%', severity: 'major' }] },
});
check('the inspector conditionally accepts with a nonconformance', r.body.status === 'completed' && r.body.nonconformances.length === 1, r);
const afterInspection = await waitFor(async () => ((await balance(green, whA))?.onHand === 1015 ? true : null));
check('only the accepted quantity enters stock (1015)', !!afterInspection, await balance(green, whA));

const key = `adj-${randomUUID()}`;
r = await call('POST', '/inventory/adjustments', { token: sam.token, org: supplier, headers: { 'idempotency-key': key }, body: { warehouseId: whA, itemId: green, quantity: '-15', reasonCode: 'count_correction' } });
const r3 = await call('POST', '/inventory/adjustments', { token: sam.token, org: supplier, headers: { 'idempotency-key': key }, body: { warehouseId: whA, itemId: green, quantity: '-15', reasonCode: 'count_correction' } });
check('adjustments are idempotent', r.status === 201 && r3.status === 200 && r3.body.movementId === r.body.movementId && (await balance(green, whA))?.onHand === 1000, [r.body, r3.body]);
r = await call('POST', `/inventory/movements/${r.body.movementId}/reverse`, { token: sam.token, org: supplier, body: { reason: 'counted the wrong shelf' } });
const again = await call('POST', `/inventory/movements/${r3.body.movementId}/reverse`, { token: sam.token, org: supplier, body: { reason: 'twice' } });
check('corrections are reversal entries, once only', r.status === 201 && r.body.type === 'reversal' && again.status === 409 && (await balance(green, whA))?.onHand === 1015, [r.body, again.body]);

r = await call('POST', '/warehouse/transfers', { token: sam.token, org: supplier, body: { fromWarehouseId: whA, toWarehouseId: whB, itemId: green, quantity: '15' } });
check('transfers move stock between warehouses', r.body.status === 'completed' && (await balance(green, whA))?.onHand === 1000 && (await balance(green, whB))?.onHand === 15, r.body);

const attempts = await Promise.all(
  Array.from({ length: 8 }, () =>
    call('POST', '/inventory/adjustments', { token: sam.token, org: supplier, headers: { 'idempotency-key': `race-${randomUUID()}` }, body: { warehouseId: whB, itemId: green, quantity: '-4', reasonCode: 'damage' } }),
  ),
);
const won = attempts.filter((a) => a.status === 201).length;
const lost = attempts.filter((a) => a.status === 409).length;
check('8 concurrent withdrawals of 4 from 15: exactly 3 succeed, no overselling', won === 3 && lost === 5 && (await balance(green, whB))?.onHand === 3, { won, lost, balance: await balance(green, whB) });

// =============================================================================
heading('Order fulfilment: reservation → shipment → carrier → delivery');
const po = async (qty) =>
  (
    await call('POST', '/purchase-orders', {
      token: bea.token,
      org: buyer,
      headers: { 'idempotency-key': `po-${randomUUID()}` },
      body: { supplierOrganizationId: supplier, currency: 'ETB', deliveryLocation: 'Addis Ababa', lines: [{ variantId: variantOf[green], quantity: qty }] },
    })
  ).body;
const order = await po('50');
await call('POST', `/sales-orders/${order.id}/confirm`, { token: sam.token, org: supplier });
const reservation = await waitFor(async () => {
  const res = await call('GET', `/inventory/reservations/order/${order.id}`, { token: sam.token, org: supplier });
  return res.status === 200 ? res.body : null;
});
check('confirming an order reserves its stock', reservation?.status === 'active' && (await balance(green))?.reserved === 50, reservation);

const bigOrder = await po('5000');
await call('POST', `/sales-orders/${bigOrder.id}/confirm`, { token: sam.token, org: supplier });
const exception = await waitFor(async () => ((await call('GET', `/purchase-orders/${bigOrder.id}`, { token: bea.token, org: buyer })).body.status === 'exception' ? true : null));
check('an order that cannot be reserved goes to exception', !!exception);
const attention = await waitFor(async () => (await call('GET', '/notifications', { token: sam.token })).body.items?.find((n) => n.templateKey === 'stock_reservation_failed'));
check('…and the supplier is told', !!attention);

const lineId = order.lines[0].id;
r = await call('POST', '/shipments', { token: sam.token, org: supplier, body: { orderId: order.id, originWarehouseId: whA, items: [{ orderLineId: lineId, quantity: '60' }] } });
check('cannot ship more than was ordered', r.status === 400 && r.body.error.code === 'over_shipment', r);
const tracking = `TRK-${randomUUID().slice(0, 8)}`;
r = await call('POST', '/shipments', { token: sam.token, org: supplier, body: { orderId: order.id, originWarehouseId: whA, carrierName: 'Test Carrier', trackingNumber: tracking, items: [{ orderLineId: lineId, quantity: '30' }] } });
const shipment1 = r.body;
r = await call('POST', `/shipments/${shipment1.id}/dispatch`, { token: sam.token, org: supplier });
const afterDispatch = await balance(green);
check('dispatch issues stock from the reservation', r.body.status === 'dispatched' && afterDispatch.onHand === 973 && afterDispatch.reserved === 20, { status: r.body.status, afterDispatch });

const carrierSecret = providerSecret('testcarrier');
const carrierBody = JSON.stringify({ eventId: `evt-${randomUUID()}`, trackingNumber: tracking, status: 'in_transit', location: 'Modjo', occurredAt: new Date().toISOString() });
r = await call('POST', '/integrations/callbacks/testcarrier', { body: carrierBody, headers: signCallback(carrierSecret, carrierBody) });
check('a signed carrier callback is processed', r.status === 200 && r.body.status === 'processed', r);
r = await call('POST', '/integrations/callbacks/testcarrier', { body: carrierBody, headers: signCallback(carrierSecret, carrierBody) });
check('…a repeat is acknowledged but not reprocessed', r.status === 200 && r.body.status === 'duplicate', r);
r = await call('POST', '/integrations/callbacks/testcarrier', { body: carrierBody.replace('Modjo', 'Adama'), headers: signCallback(carrierSecret, carrierBody) });
check('…a tampered body is refused', r.status === 401, r);
r = await call('POST', '/integrations/callbacks/testcarrier', { body: carrierBody, headers: signCallback(carrierSecret, carrierBody, Math.floor(Date.now() / 1000) - 3600) });
check('…an old (replayed) callback is refused', r.status === 401, r);
r = await call('GET', `/shipments/${shipment1.id}`, { token: bea.token, org: buyer });
check('the buyer sees it in transit', r.body.status === 'in_transit', r.body.status);

r = await call('POST', `/shipments/${shipment1.id}/confirm-delivery`, { token: bea.token, org: buyer, body: { recipientName: 'Bea', items: [{ orderLineId: lineId, deliveredQuantity: '30' }] } });
check('the buyer confirms delivery', r.body.status === 'delivered', r);
const partial = await waitFor(async () => ((await call('GET', `/purchase-orders/${order.id}`, { token: bea.token, org: buyer })).body.status === 'partially_fulfilled' ? true : null));
check('the order is partially fulfilled', !!partial);
const s2 = (await call('POST', '/shipments', { token: sam.token, org: supplier, body: { orderId: order.id, originWarehouseId: whA, items: [{ orderLineId: lineId, quantity: '20' }] } })).body;
await call('POST', `/shipments/${s2.id}/dispatch`, { token: sam.token, org: supplier });
await call('POST', `/shipments/${s2.id}/confirm-delivery`, { token: bea.token, org: buyer, body: { recipientName: 'Bea', items: [{ orderLineId: lineId, deliveredQuantity: '20' }] } });
const fulfilled = await waitFor(async () => ((await call('GET', `/purchase-orders/${order.id}`, { token: bea.token, org: buyer })).body.status === 'fulfilled' ? true : null));
check('…then fulfilled, with the reservation fully consumed', !!fulfilled && (await balance(green))?.reserved === 0, await balance(green));
r = await call('POST', `/purchase-orders/${order.id}/close`, { token: bea.token, org: buyer });
check('the buyer closes the fulfilled order', r.body.status === 'closed', r.body.status);

// =============================================================================
heading('Invoicing & reconciliation (payments never inferred)');
r = await call('POST', '/invoices/from-order', { token: sam.token, org: supplier, body: { orderId: order.id, taxRatePct: '15', dueInDays: 30 } });
const invoice = r.body;
check('invoice from the order, with 15% tax per line', r.status === 201 && invoice.total === '24150', invoice);
await call('POST', `/invoices/${invoice.id}/issue`, { token: sam.token, org: supplier });
r = await call('POST', `/invoices/${invoice.id}/payments`, { token: bea.token, org: buyer, body: { provider: 'bank_transfer', externalReference: `CBE-${randomUUID().slice(0, 8)}`, amount: '24150.00', paidAt: new Date().toISOString() } });
check("a buyer's payment claim does not mark the invoice paid", r.body.status === 'issued' && r.body.outstanding === '24150', r.body);

const paySecret = providerSecret('testpay');
const payRun = randomUUID().slice(0, 8);
const payment = (type, reference, amount, eventId = `pay-${randomUUID()}`) => {
  const body = JSON.stringify({ eventId, type, reference, invoiceNumber: invoice.number, amount, currency: 'ETB', occurredAt: new Date().toISOString() });
  return call('POST', '/integrations/callbacks/testpay', { body, headers: signCallback(paySecret, body) });
};
await payment('payment.confirmed', `tx-1-${payRun}`, '10000.00');
r = await call('GET', `/invoices/${invoice.id}`, { token: bea.token, org: buyer });
check('a verified provider payment is applied', r.body.status === 'partially_paid' && r.body.outstanding === '14150', r.body);
await payment('payment.confirmed', `tx-1-${payRun}`, '10000.00');
r = await call('GET', `/invoices/${invoice.id}`, { token: bea.token, org: buyer });
check('a duplicate provider event (new event ID, same reference) changes nothing', r.body.outstanding === '14150', r.body.outstanding);
await payment('payment.confirmed', `tx-2-${payRun}`, '14150.00');
r = await call('GET', `/invoices/${invoice.id}`, { token: sam.token, org: supplier });
check('fully paid after the second payment', r.body.status === 'paid', r.body.status);
await payment('payment.reversed', `tx-1-${payRun}`, '10000.00');
r = await call('GET', `/invoices/${invoice.id}`, { token: sam.token, org: supplier });
check('a reversal reopens the balance, with an audit trail', r.body.status === 'partially_paid' && r.body.payments.some((p) => p.reconciliations.some((x) => x.appliedAmount === '-10000')), r.body.status);
r = await call('POST', '/invoices', { token: sam.token, org: supplier, body: { buyerOrganizationId: buyer, currency: 'ETB', dueInDays: 30, lines: [{ description: 'Sample', quantity: '1', unitPrice: '100', taxRatePct: '0' }] } });
await call('POST', `/invoices/${r.body.id}/issue`, { token: sam.token, org: supplier });
{
  const body = JSON.stringify({ eventId: `pay-${randomUUID()}`, type: 'payment.confirmed', reference: `tx-2-${payRun}`, invoiceNumber: r.body.number, amount: '100.00', currency: 'ETB', occurredAt: new Date().toISOString() });
  const res = await call('POST', '/integrations/callbacks/testpay', { body, headers: signCallback(paySecret, body) });
  check('a provider reference reused for another invoice is refused, not ignored', res.status === 422, res);
}
r = await call('POST', `/invoices/${invoice.id}/void`, { token: sam.token, org: supplier, body: { reason: 'try to void' } });
check('invoices with payments cannot be voided (use credit notes)', r.status === 409, r);
r = await call('POST', `/invoices/${invoice.id}/credit-notes`, { token: sam.token, org: supplier, body: { amount: '1000.00', reason: 'Goodwill for late delivery' } });
check('a credit note reduces what is owed', r.body.outstanding === '9000', r.body.outstanding);

// =============================================================================
heading('Disputes & supplier performance');
const photo = (await upload(bea, buyer, { classification: 'dispute_evidence', fileName: 'torn-bags.png', contentType: 'image/png', bytes: PNG() })).body;
r = await call('POST', '/disputes', { token: bea.token, org: buyer, body: { subjectType: 'order', subjectId: order.id, orderId: order.id, category: 'quality', description: 'Several bags arrived torn and wet.', evidenceDocumentIds: [photo.id] } });
const dispute = r.body;
check('the buyer opens a dispute with evidence', r.status === 201 && dispute.againstOrganizationId === supplier, r);
r = await call('GET', `/documents/${photo.id}/download-url`, { token: sam.token, org: supplier });
check('the other party can read the evidence', r.status === 200, r);
r = await call('GET', `/disputes/${dispute.id}`, { token: eve.token, org: outsider });
check('outsiders cannot see the dispute', r.status === 404, r);
await call('POST', `/disputes/${dispute.id}/statements`, { token: sam.token, org: supplier, body: { text: 'Bags were intact at dispatch.' } });
await call('POST', `/disputes-review/${dispute.id}/claim`, { token: admin.token });
r = await call('POST', `/disputes-review/${dispute.id}/resolve`, { token: admin.token, body: { outcome: 'in_favor_of_opener', summary: 'Photos show water damage before delivery.', followUpActions: 'Supplier issues a credit note for 5 kg.' } });
check('a reviewer resolves it with reasons and follow-ups (no direct edits)', r.body.status === 'resolved', r.body.status);
r = await call('POST', `/disputes/${dispute.id}/appeal`, { token: sam.token, org: supplier, body: { reason: 'The carrier caused the damage, not us.' } });
const r4 = await call('POST', `/disputes/${dispute.id}/appeal`, { token: sam.token, org: supplier, body: { reason: 'Appealing a second time.' } });
check('one appeal per decision', r.status === 201 && r4.status === 409, [r.status, r4.status]);

r = await call('POST', '/disputes', { token: bea.token, org: buyer, body: { subjectType: 'invoice', subjectId: invoice.id, orderId: order.id, category: 'payment', description: 'Tax rate applied incorrectly.' } });
const disputed = await waitFor(async () => ((await call('GET', `/invoices/${invoice.id}`, { token: sam.token, org: supplier })).body.status === 'disputed' ? true : null));
check('a disputed invoice is frozen', !!disputed);

const perf = await waitFor(async () => {
  const p = await call('GET', `/performance/suppliers/${supplier}`, { token: bea.token });
  return p.body.disputesLost >= 1 ? p.body : null;
});
check('supplier performance is computed from facts (reproducible formula)', perf?.formulaVersion === 'perf-2026.1' && perf.ordersReceived === 2 && perf.confirmationRatePct === 100, perf);

// =============================================================================
heading('Agriculture: harvests → lots → split/merge, with traceability');
const farm = (await call('POST', '/agriculture/farms', { token: sam.token, org: supplier, body: { name: 'Gedeb smallholder #12', region: 'Gedeo', woreda: 'Gedeb', areaHectares: '1.5' } })).body;
const season = (await call('POST', '/agriculture/seasons', { token: sam.token, org: supplier, body: { farmId: farm.id, crop: 'coffee', year: 2026, season: 'meher', unitOfMeasure: 'kg' } })).body;
const h1 = (await call('POST', `/agriculture/seasons/${season.id}/harvests`, { token: sam.token, org: supplier, body: { harvestedAt: new Date().toISOString(), quantity: '100' } })).body;
const h2 = (await call('POST', `/agriculture/seasons/${season.id}/harvests`, { token: sam.token, org: supplier, body: { harvestedAt: new Date().toISOString(), quantity: '80' } })).body;
r = await call('POST', '/agriculture/lots', { token: sam.token, org: supplier, body: { warehouseId: whB, harvests: [{ harvestId: h1.id, quantity: '100' }, { harvestId: h2.id, quantity: '60' }] } });
const lot = r.body;
check('a lot aggregates harvests and gets a printable code', r.status === 201 && /^LOT-\d{4}-/.test(lot.lotCode) && lot.quantity === '160', lot);
r = await call('POST', '/agriculture/lots', { token: sam.token, org: supplier, body: { harvests: [{ harvestId: h2.id, quantity: '30' }] } });
check('a harvest cannot be assigned twice (only 20 left)', r.status === 400 && r.body.error.code === 'over_allocation', r);
check('the lot is in stock at its warehouse', (await balance(lot.id, whB))?.onHand === 160, await balance(lot.id, whB));
r = await call('POST', `/agriculture/lots/${lot.id}/split`, { token: sam.token, org: supplier, body: { quantities: ['100', '60'] } });
const [part1, part2] = r.body;
check('splitting conserves quantity', part1?.quantity === '100' && part2?.quantity === '60', r.body);
r = await call('POST', `/agriculture/lots/${lot.id}/split`, { token: sam.token, org: supplier, body: { quantities: ['10', '10'] } });
check('a fully split lot is depleted', r.status === 409, r);
const stockMoved = await waitFor(async () => ((await balance(part1.id, whB))?.onHand === 100 && (await balance(lot.id, whB))?.onHand === 0 ? true : null));
check('stock follows the split in Inventory', !!stockMoved);
const merged = (await call('POST', '/agriculture/lots/merge', { token: sam.token, org: supplier, body: { lotIds: [part1.id, part2.id], grade: 'Grade 1' } })).body;
r = await call('GET', `/agriculture/lots/${merged.id}/trace`, { token: sam.token, org: supplier });
const trace = r.body;
const farms = JSON.stringify(trace).match(/Gedeb smallholder #12/g)?.length ?? 0;
check('a merged lot traces back through both parts to the farm', trace.parents?.length === 2 && trace.parents[0].lot.parents[0].lot.harvests.length === 2 && farms >= 2, trace);

// =============================================================================
heading('Manufacturing: BOM → reserve → produce → batch lineage');
const bom = (await call('POST', '/manufacturing/boms', { token: sam.token, org: supplier, body: { name: 'Light roast', outputItemId: roasted, outputQuantity: '100', unitOfMeasure: 'kg', components: [{ itemId: green, description: 'Green coffee', quantity: '120', unitOfMeasure: 'kg' }] } })).body;
const tooBig = (await call('POST', '/manufacturing/production-orders', { token: sam.token, org: supplier, body: { bomId: bom.id, plannedOutput: '5000', warehouseId: whA } })).body;
r = await call('POST', `/manufacturing/production-orders/${tooBig.id}/release`, { token: sam.token, org: supplier });
check('production without enough materials is refused, with shortages', r.status === 409 && r.body.error.code === 'insufficient_materials' && r.body.error.details?.[0]?.requested === '6000', r.body);
const run = (await call('POST', '/manufacturing/production-orders', { token: sam.token, org: supplier, body: { bomId: bom.id, plannedOutput: '250', warehouseId: whA } })).body;
r = await call('POST', `/manufacturing/production-orders/${run.id}/release`, { token: sam.token, org: supplier });
check('releasing reserves the scaled materials (300 kg)', r.body.status === 'released' && (await balance(green, whA))?.reserved === 300, await balance(green, whA));
const greenBefore = (await balance(green, whA)).onHand;
r = await call('POST', `/manufacturing/production-orders/${run.id}/complete`, { token: sam.token, org: supplier, body: { outputQuantity: '240', wasteQuantity: '8' } });
const completed = r.body;
check('completion records yield and a batch', completed.status === 'completed' && completed.yieldPercent === '96' && /^B-\d{4}-/.test(completed.batch?.batchCode), completed);
const stocked = await waitFor(async () => {
  const g = await balance(green, whA);
  const out = await balance(roasted, whA);
  return g.onHand === greenBefore - 300 && g.reserved === 0 && out.onHand === 240 ? true : null;
});
check('materials are issued, output is stocked, reservation released', !!stocked, { green: await balance(green, whA), roasted: await balance(roasted, whA) });
r = await call('GET', `/manufacturing/batches/${completed.batch.id}/trace`, { token: sam.token, org: supplier });
check('batch lineage lists its inputs', r.body.inputs?.[0]?.itemId === green && r.body.inputs[0].quantity === '300', r.body);

// =============================================================================
heading('Analytics (tenant-scoped)');
const summary = await waitFor(async () => {
  const s = await call('GET', '/analytics/summary', { token: sam.token, org: supplier });
  return s.body.counts?.orders_received >= 2 && s.body.counts?.production_runs >= 1 ? s.body : null;
});
check('the supplier sees its own counters, values and rates', summary?.amounts?.sales_value?.ETB && summary.rates.orderConfirmationRatePct === 100, summary);
r = await call('GET', '/analytics/summary', { token: bea.token, org: supplier });
check("an organization cannot read another's analytics", r.status === 404, r);

// =============================================================================
heading('Controlled admin workflow: suspension');
r = await call('POST', `/admin/organizations/${outsider}/status`, { token: admin.token, body: { status: 'suspended', reasonCode: 'fraud_report', reason: 'Reported for fake listings, under investigation' } });
check('admin suspends an organization through Organization’s own API', r.body.status === 'suspended', r);
r = await call('GET', '/catalog/products', { token: eve.token, org: outsider });
check('a suspended organization cannot act', r.status === 403 && r.body.error.code === 'organization_inactive', r);
await call('POST', `/admin/organizations/${outsider}/status`, { token: admin.token, body: { status: 'active', reasonCode: 'investigation_closed', reason: 'Reports were unfounded' } });
r = await call('GET', `/admin/audit?targetType=organization&targetId=${outsider}`, { token: admin.token });
check('both actions are in the audit log with reasons', r.body.items?.length === 2 && r.body.items.every((a) => a.reasonCode && a.reason), r.body.items);

finish();
