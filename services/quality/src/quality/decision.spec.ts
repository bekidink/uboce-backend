import { describe, expect, it } from 'vitest';

import { Prisma } from '../generated/prisma/client.js';
import { validateResults } from './decision.js';

const line = (inspected: number, accepted: string, rejected: string) => ({
  itemId: 'i1',
  inspectedQuantity: new Prisma.Decimal(inspected),
  acceptedQuantity: accepted,
  rejectedQuantity: rejected,
});

describe('inspection results', () => {
  it('requires every inspected unit to be accounted for', () => {
    expect(validateResults('accepted', [line(50, '49', '0')])).toContain('must equal');
    expect(validateResults('accepted', [line(50, '50', '0')])).toBeNull();
  });

  it('keeps the decision consistent with the quantities', () => {
    expect(validateResults('accepted', [line(50, '45', '5')])).toContain('conditionally_accepted');
    expect(validateResults('rejected', [line(50, '1', '49')])).toContain('conditionally_accepted');
    expect(validateResults('conditionally_accepted', [line(50, '45', '5')])).toBeNull();
    expect(validateResults('conditionally_accepted', [line(50, '50', '0')])).not.toBeNull();
  });
});
