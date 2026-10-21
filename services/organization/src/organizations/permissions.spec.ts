import { describe, expect, it } from 'vitest';

import { canAssignRole, hasPermission } from './permissions.js';

describe('organization permissions', () => {
  it('lets owners and admins manage members', () => {
    expect(hasPermission('owner', 'members:manage')).toBe(true);
    expect(hasPermission('admin', 'members:manage')).toBe(true);
  });

  it('keeps operational roles read-only', () => {
    expect(hasPermission('procurement_officer', 'organization:read')).toBe(true);
    expect(hasPermission('procurement_officer', 'members:manage')).toBe(false);
    expect(hasPermission('auditor', 'organization:update')).toBe(false);
  });

  it('only lets owners grant ownership', () => {
    expect(canAssignRole('owner', 'owner')).toBe(true);
    expect(canAssignRole('admin', 'owner')).toBe(false);
    expect(canAssignRole('admin', 'warehouse_operator')).toBe(true);
    expect(canAssignRole('finance_officer', 'auditor')).toBe(false);
  });
});
