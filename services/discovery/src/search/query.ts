// Free-text search terms → a safe Postgres tsquery. Prefix matching (`cof` finds
// "coffee") and the 'simple' configuration, which works for Amharic and English
// alike (Postgres has no Amharic stemmer). Common local names and spellings are
// expanded as synonyms (PRD addendum 2.11); typos are caught by trigram similarity.

const MAX_TERMS = 8;

/** Groups of words buyers use for the same thing (English, Amharic, transliterations). */
const SYNONYM_GROUPS: string[][] = [
  ['coffee', 'buna', 'bunna', 'ቡና'],
  ['teff', 'tef', 'tefe', 'ጤፍ'],
  ['sesame', 'selit', 'ሰሊጥ'],
  ['wheat', 'sinde', 'ስንዴ'],
  ['barley', 'gebs', 'ገብስ'],
  ['maize', 'corn', 'bekolo', 'በቆሎ'],
  ['sorghum', 'mashila', 'ማሽላ'],
  ['chickpea', 'chickpeas', 'shimbra', 'ሽንብራ'],
  ['lentil', 'lentils', 'misir', 'ምስር'],
  ['beans', 'bean', 'bakela', 'ባቄላ', 'haricot'],
  ['honey', 'mar', 'ማር'],
  ['spice', 'spices', 'berbere', 'በርበሬ'],
  ['cement', 'simint', 'ሲሚንቶ'],
  ['washed', 'wet-processed'],
  ['natural', 'sun-dried', 'unwashed'],
];

const SYNONYMS = new Map<string, string[]>();
for (const group of SYNONYM_GROUPS) for (const word of group) SYNONYMS.set(word, group);

/** Normalized search terms (letters and digits of any script, lower case). */
export function terms(input: string | undefined): string[] {
  if (!input) return [];
  return input
    .normalize('NFKC')
    .toLowerCase()
    // Keep letters (any script, incl. Ge'ez) and digits; everything else separates terms.
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0)
    .slice(0, MAX_TERMS);
}

/** tsquery-safe word (letters/digits only after `terms`; hyphenated synonyms are split). */
const lexemes = (word: string) => word.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Returns null when there is nothing searchable in the input. Each term matches itself or a synonym. */
export function toPrefixTsQuery(input: string | undefined): string | null {
  const list = terms(input);
  if (list.length === 0) return null;
  return list
    .map((t) => {
      const alternatives = [...new Set([t, ...(SYNONYMS.get(t) ?? [])])].flatMap((w) => {
        const parts = lexemes(w);
        return parts.length ? [parts.map((p) => `${p}:*`).join(' & ')] : [];
      });
      return alternatives.length > 1 ? `(${alternatives.map((a) => (a.includes('&') ? `(${a})` : a)).join(' | ')})` : alternatives[0]!;
    })
    .join(' & ');
}

/** Text for trigram matching: the query with synonyms appended. */
export function similarityText(input: string | undefined) {
  const list = terms(input);
  return list.join(' ');
}

/** "grade:1,process:washed" → [['grade','1'], ['process','washed']] (max 10 filters). */
export function parseAttributeFilters(input: string | undefined): [string, string][] {
  if (!input) return [];
  return input
    .split(',')
    .map((pair) => pair.split(':').map((s) => s.trim()))
    .filter((p): p is [string, string] => p.length === 2 && /^[a-z][a-z0-9_]{0,39}$/.test(p[0]!) && p[1]!.length > 0 && p[1]!.length <= 100)
    .slice(0, 10);
}
