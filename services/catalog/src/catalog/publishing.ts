// Publication rules (PRD 5.5), kept free of I/O so they're easy to test.

export interface PublishCandidate {
  attributes: Record<string, string>;
  variants: { isActive: boolean }[];
}

/** Everything blocking publication, as human-readable problems; empty means publishable. */
export function publicationProblems(product: PublishCandidate, requiredAttributes: string[]): string[] {
  const problems: string[] = [];
  const missing = requiredAttributes.filter((key) => !product.attributes[key]?.trim());
  if (missing.length) problems.push(`Missing required attributes: ${missing.join(', ')}`);
  if (!product.variants.some((v) => v.isActive)) problems.push('At least one active variant with a price is required');
  return problems;
}

/** Attribute values are short strings; keys are snake_case identifiers. */
export function normalizeAttributes(input: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(key)) throw new Error(`Invalid attribute key "${key}"`);
    if (typeof value !== 'string' || value.length > 200) throw new Error(`Attribute "${key}" must be a string of at most 200 characters`);
    out[key] = value.trim();
  }
  if (Object.keys(out).length > 40) throw new Error('At most 40 attributes');
  return out;
}
