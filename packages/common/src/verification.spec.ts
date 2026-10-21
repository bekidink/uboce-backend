import { describe, expect, it } from 'vitest';

import { canTransitionCase, missingRequirements, nextAction } from './verification.js';

describe('verification case lifecycle', () => {
  it('only reviewers decide, only subjects submit', () => {
    expect(canTransitionCase('in_review', 'approved', 'reviewer')).toBe(true);
    expect(canTransitionCase('in_review', 'approved', 'subject')).toBe(false);
    expect(canTransitionCase('draft', 'submitted', 'subject')).toBe(true);
    expect(canTransitionCase('draft', 'submitted', 'reviewer')).toBe(false);
  });

  it('cannot skip review', () => {
    expect(canTransitionCase('submitted', 'approved', 'reviewer')).toBe(false);
  });

  it('rejected and expired cases are final', () => {
    for (const to of ['approved', 'submitted', 'in_review'] as const) {
      expect(canTransitionCase('rejected', to, 'reviewer')).toBe(false);
      expect(canTransitionCase('expired', to, 'reviewer')).toBe(false);
    }
  });

  it('only the system expires approvals', () => {
    expect(canTransitionCase('approved', 'expired', 'system')).toBe(true);
    expect(canTransitionCase('approved', 'expired', 'reviewer')).toBe(false);
  });

  it('tells the subject what to do next', () => {
    expect(missingRequirements(['national_id', 'proof_of_address'], ['national_id'])).toEqual(['proof_of_address']);
    expect(nextAction('draft', ['proof_of_address'])).toBe('Upload: proof_of_address');
    expect(nextAction('in_review', [])).toBe('Wait for review');
  });
});
