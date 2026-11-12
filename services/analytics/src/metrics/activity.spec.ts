import { describe, expect, it } from 'vitest';

import { activityRows } from './activity.js';

const SELLER = '11111111-1111-4111-8111-111111111111';
const BUYER = '22222222-2222-4222-8222-222222222222';
const env = (eventType: string, data: Record<string, unknown>) =>
  ({ eventId: '33333333-3333-4333-8333-333333333333', eventType, aggregateId: 'a', occurredAt: '2026-11-01T00:00:00Z', data }) as never;

describe('activity actor', () => {
  it('marks the party that acted, whatever the payload key order', () => {
    const rows = activityRows(env('ReturnRequested', { supplierOrganizationId: SELLER, buyerOrganizationId: BUYER, status: 'requested' }));
    expect(rows.find((r) => r.organizationId === BUYER)?.own).toBe(true);
    expect(rows.find((r) => r.organizationId === SELLER)?.own).toBe(false);
  });

  it('marks nobody when the actor is unknown', () => {
    const rows = activityRows(env('DisputeResolved', { openedByOrganizationId: BUYER, againstOrganizationId: SELLER }));
    expect(rows.every((r) => !r.own)).toBe(true);
  });
});
