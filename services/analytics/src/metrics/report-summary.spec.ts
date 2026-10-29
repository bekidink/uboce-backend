import { describe, expect, it } from 'vitest';

import { keepCited, ruleSummary } from './report-summary.js';

const sources = [
  { id: 'S1', label: 'Orders received', value: '12' },
  { id: 'S2', label: 'Sales value (ETB)', value: '84000.00' },
  { id: 'S3', label: 'Order confirmation rate (%)', value: '66.7' },
  { id: 'S4', label: 'Merkato store: cancelled', value: '2' },
];

describe('report summary guards', () => {
  it('drops points that cite nothing or unknown sources', () => {
    const kept = keepCited(
      {
        headline: 'h',
        highlights: [
          { text: 'ok', sourceIds: ['S1'] },
          { text: 'made up', sourceIds: ['S9'] },
          { text: 'uncited', sourceIds: [] },
        ],
        concerns: [],
        suggestions: [],
      },
      sources,
    );
    expect(kept.highlights.map((p) => p.text)).toEqual(['ok']);
  });

  it('builds a cited rule-based summary', () => {
    const s = ruleSummary(sources);
    expect(s.headline).toContain('12');
    expect(s.concerns.map((c) => c.sourceIds[0])).toEqual(['S3', 'S4']);
    expect([...s.highlights, ...s.concerns].every((p) => p.sourceIds.length > 0)).toBe(true);
  });
});
