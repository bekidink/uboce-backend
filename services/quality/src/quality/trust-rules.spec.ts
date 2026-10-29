import { describe, expect, it } from 'vitest';

import { needsModeration, scorecardScore } from './trust-rules.js';

describe('review moderation', () => {
  it('holds reviews with links or contact details', () => {
    expect(needsModeration('Great beans, call me on +251 911 223344')).toBe(true);
    expect(needsModeration('See www.example.com')).toBe(true);
    expect(needsModeration('mail sales@x.et')).toBe(true);
    expect(needsModeration('Great beans, delivered on time')).toBe(false);
  });
});

describe('scorecard score', () => {
  it('weights pass rate, claims and rating', () => {
    expect(scorecardScore({ inspections: 10, passed: 10, claims: 0, averageRating: 5 })).toBe(100);
    expect(scorecardScore({ inspections: 10, passed: 5, claims: 0, averageRating: 5 })).toBe(75);
    expect(scorecardScore({ inspections: 0, passed: 0, claims: 0, averageRating: null })).toBe(0);
    expect(scorecardScore({ inspections: 0, passed: 0, claims: 0, averageRating: 3 })).toBe(50);
  });
});
