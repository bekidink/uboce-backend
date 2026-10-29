// Review moderation and scorecard formula (PRD addendum 2.5), without I/O.

const LINK = /(https?:\/\/|www\.|\.(com|et|net|org)\b)/i;
const PHONE = /(\+?\d[\d\s-]{7,}\d)/;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/;

/** Reviews with links or contact details wait for a moderator (spam, off-platform deals). */
export function needsModeration(text: string) {
  return LINK.test(text) || PHONE.test(text) || EMAIL.test(text);
}

export const SCORE_FORMULA_VERSION = 1;

/**
 * Score 0–100, formula v1: 50% inspection pass rate, 30% claim-free rate (claims per inspection,
 * capped), 20% average rating. Missing parts count as neutral (their weight goes to the others).
 */
export function scorecardScore(input: { inspections: number; passed: number; claims: number; averageRating: number | null }) {
  const parts: { weight: number; value: number }[] = [];
  if (input.inspections > 0) {
    parts.push({ weight: 50, value: input.passed / input.inspections });
    parts.push({ weight: 30, value: Math.max(0, 1 - input.claims / input.inspections) });
  } else if (input.claims > 0) {
    parts.push({ weight: 30, value: 0 });
  }
  if (input.averageRating !== null) parts.push({ weight: 20, value: (input.averageRating - 1) / 4 });
  const weight = parts.reduce((s, p) => s + p.weight, 0);
  if (!weight) return 0;
  return Math.round((parts.reduce((s, p) => s + p.weight * p.value, 0) / weight) * 10000) / 100;
}
