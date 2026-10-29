// Business locations and scoped staff (PRD addendum 2.1–2.2): node scripts/smoke-locations.mjs
// Needs the stack running (pnpm start / pnpm dev). Creates its own throwaway users.
import { call, check, finish, heading, newUser, register } from './smoke-lib.mjs';

heading('Business profile and locations');
const owner = await register(newUser('LocOwner'));
const worker = await register(newUser('LocWorker'));

const org = await call('POST', '/organizations', {
  token: owner.token,
  body: { name: 'Scoped Traders', type: 'wholesaler', businessModels: ['wholesale', 'retail'], contactPhone: '+251 911 000000' },
});
check('organization created with business models', org.status === 201 && org.body.businessModels?.length === 2, org.body);
const orgId = org.body.id;

const hours = [
  { day: 1, opens: '08:00', closes: '18:00' },
  { day: 6, opens: '09:00', closes: '13:00' },
];
const store = await call('POST', `/organizations/${orgId}/branches`, {
  token: owner.token,
  body: { name: 'Merkato store', kind: 'store', city: 'Addis Ababa', operatingHours: hours, pickupEnabled: true, serviceAreas: ['Addis Ababa'] },
});
check('store created with hours', store.status === 201 && store.body.operatingHours.length === 2 && store.body.pickupEnabled, store.body);
const depot = await call('POST', `/organizations/${orgId}/branches`, { token: owner.token, body: { name: 'Adama depot', kind: 'warehouse' } });
check('second location created', depot.status === 201, depot.body);

const badHours = await call('POST', `/organizations/${orgId}/branches`, {
  token: owner.token,
  body: { name: 'Bad', operatingHours: [{ day: 9, opens: '25:00', closes: 'x' }] },
});
check('invalid hours rejected', badHours.status === 400, badHours.body);

const closed = await call('PATCH', `/organizations/${orgId}/branches/${depot.body.id}`, { token: owner.token, body: { active: false, phone: '+251 22 111 2222' } });
check('location updated', closed.status === 200 && closed.body.active === false, closed.body);
await call('PATCH', `/organizations/${orgId}/branches/${depot.body.id}`, { token: owner.token, body: { active: true } });

heading('Location-scoped staff');
const added = await call('POST', `/organizations/${orgId}/members`, { token: owner.token, body: { userId: worker.id, role: 'warehouse_operator' } });
check('worker added', added.status === 201, added.body);
const memberId = added.body.id;

for (const [code, branch] of [['MKT', store], ['ADM', depot]]) {
  const w = await call('POST', '/warehouse/warehouses', { token: owner.token, org: orgId, body: { code, name: `${code} warehouse`, branchId: branch.body.id } });
  check(`warehouse ${code} at its location`, w.status === 201 && w.body.branchId === branch.body.id, w.body);
}

const scoped = await call('PUT', `/organizations/${orgId}/members/${memberId}/locations`, { token: owner.token, body: { branchIds: [store.body.id] } });
check('worker limited to the store', scoped.status === 200 && scoped.body.locationIds?.length === 1, scoped.body);

const access = await call('GET', `/organizations/${orgId}/access`, { token: worker.token });
check('access shows the location scope', access.body.locationIds?.[0] === store.body.id, access.body);

const seen = await call('GET', '/warehouse/warehouses', { token: worker.token, org: orgId });
check('scoped worker sees only their warehouse', seen.status === 200 && seen.body.items.map((w) => w.code).join() === 'MKT', seen.body);
const all = await call('GET', '/warehouse/warehouses', { token: owner.token, org: orgId });
check('owner sees every warehouse', all.body.items?.length === 2, all.body);

const elsewhere = await call('POST', '/warehouse/warehouses', { token: worker.token, org: orgId, body: { code: 'NOPE', name: 'Nope' } });
check('worker cannot create warehouses', elsewhere.status === 403, elsewhere.body);

const ownerScope = await call('PUT', `/organizations/${orgId}/members/${org.body.id}/locations`, { token: owner.token, body: { branchIds: [] } });
check('unknown membership is 404', ownerScope.status === 404, ownerScope.body);

heading('Suspension');
const suspended = await call('POST', `/organizations/${orgId}/members/${memberId}/suspend`, { token: owner.token });
check('worker suspended', suspended.status === 200 && suspended.body.status === 'suspended', suspended.body);
const blocked = await call('GET', '/warehouse/warehouses', { token: worker.token, org: orgId });
check('suspended worker loses access in other services', blocked.status === 404, blocked.body);
const blockedOrg = await call('GET', `/organizations/${orgId}`, { token: worker.token });
check('suspended worker sees why', blockedOrg.status === 403 && blockedOrg.body.error?.code === 'membership_suspended', blockedOrg.body);
const members = await call('GET', `/organizations/${orgId}/members`, { token: owner.token });
check('suspended member still listed', members.body.items?.some((m) => m.id === memberId && m.status === 'suspended'), members.body);

const self = await call('POST', `/organizations/${orgId}/members/${members.body.items.find((m) => m.userId === owner.id).id}/suspend`, { token: owner.token });
check('cannot suspend yourself', self.status === 403, self.body);

const back = await call('POST', `/organizations/${orgId}/members/${memberId}/reactivate`, { token: owner.token });
check('worker reactivated', back.status === 200 && back.body.status === 'active', back.body);
const again = await call('GET', '/warehouse/warehouses', { token: worker.token, org: orgId });
check('reactivated worker keeps their scope', again.status === 200 && again.body.items?.length === 1, again.body);

finish();
