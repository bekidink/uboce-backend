import { MODULES, moduleDefault } from '@uboce/contracts';
import { describe, expect, it } from 'vitest';

import { type ActingOrganization, requireBusinessAccount } from './acting-organization.js';

const member = (type: string) => ({ role: 'owner', organization: { id: 'o', name: 'X', type, countryCode: 'ET', status: 'active', verificationStatus: 'unverified' } }) as unknown as ActingOrganization;

describe('personal (single customer) accounts', () => {
  it('may not sell', () => {
    expect(() => requireBusinessAccount(member('individual'), 'list products')).toThrow(/personal account cannot list products/);
    expect(() => requireBusinessAccount(member('wholesaler'), 'list products')).not.toThrow();
  });

  it('get core buying modules plus returns and messages only', () => {
    const on = MODULES.filter((m) => moduleDefault(m, 'individual')).map((m) => m.key);
    expect(on).toEqual(expect.arrayContaining(['catalog', 'procurement', 'sales', 'finance', 'returns', 'chat']));
    expect(on).not.toContain('inventory');
    expect(on).not.toContain('warehouse');
    expect(on).not.toContain('promotions');
  });
});
