// Free-text search terms → a safe Postgres tsquery. Prefix matching (`cof` finds
// "coffee") and the 'simple' configuration, which works for Amharic and English
// alike (Postgres has no Amharic stemmer).

const MAX_TERMS = 8;

/** Returns null when there is nothing searchable in the input. */
export function toPrefixTsQuery(input: string | undefined): string | null {
  if (!input) return null;
  const terms = input
    .normalize('NFKC')
    .toLowerCase()
    // Keep letters (any script, incl. Ge'ez) and digits; everything else separates terms.
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0)
    .slice(0, MAX_TERMS);
  if (terms.length === 0) return null;
  return terms.map((t) => `${t}:*`).join(' & ');
}
