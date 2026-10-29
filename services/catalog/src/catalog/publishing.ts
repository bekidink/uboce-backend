// Publication rules (PRD 5.5, addendum 2.3), kept free of I/O so they're easy to test.

export type AttributeType = 'text' | 'number' | 'enum' | 'boolean';

/** One typed category attribute, e.g. { key: 'moisture_pct', type: 'number', unit: '%', max: 20 }. */
export interface AttributeDefinition {
  key: string;
  label: string;
  type: AttributeType;
  unit?: string;
  options?: string[];
  required?: boolean;
  /** Offered as a search filter. */
  filterable?: boolean;
  min?: number;
  max?: number;
}

export interface PublishCandidate {
  attributes: Record<string, string>;
  variants: { isActive: boolean }[];
}

/** Required keys: from the typed definitions, or the legacy list for categories without them. */
export const requiredKeys = (definitions: AttributeDefinition[], legacy: string[]) =>
  definitions.length ? definitions.filter((d) => d.required).map((d) => d.key) : legacy;

/** Everything blocking publication, as human-readable problems; empty means publishable. */
export function publicationProblems(product: PublishCandidate, requiredAttributes: string[], definitions: AttributeDefinition[] = []): string[] {
  const problems: string[] = [];
  const missing = requiredKeys(definitions, requiredAttributes).filter((key) => !product.attributes[key]?.trim());
  if (missing.length) problems.push(`Missing required attributes: ${missing.join(', ')}`);
  problems.push(...attributeTypeProblems(product.attributes, definitions));
  if (!product.variants.some((v) => v.isActive)) problems.push('At least one active variant with a price is required');
  return problems;
}

/** Values that don't fit their definition (wrong number, unknown option…). Unknown keys are allowed. */
export function attributeTypeProblems(values: Record<string, string>, definitions: AttributeDefinition[]): string[] {
  const problems: string[] = [];
  for (const def of definitions) {
    const raw = values[def.key]?.trim();
    if (!raw) continue;
    const label = def.label || def.key;
    switch (def.type) {
      case 'number': {
        const n = Number(raw);
        if (!/^-?\d+(\.\d+)?$/.test(raw) || !Number.isFinite(n)) problems.push(`${label} must be a number`);
        else if (def.min !== undefined && n < def.min) problems.push(`${label} must be at least ${def.min}${def.unit ?? ''}`);
        else if (def.max !== undefined && n > def.max) problems.push(`${label} must be at most ${def.max}${def.unit ?? ''}`);
        break;
      }
      case 'enum':
        if (def.options?.length && !def.options.includes(raw)) problems.push(`${label} must be one of: ${def.options.join(', ')}`);
        break;
      case 'boolean':
        if (raw !== 'true' && raw !== 'false') problems.push(`${label} must be true or false`);
        break;
      default:
        break;
    }
  }
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

export interface Tier {
  minQuantity: number;
  unitPrice: number;
}

/** The tier for a quantity: the one with the largest minimum at or below it. */
export function tierFor<T extends Tier>(tiers: T[], quantity: number): T | null {
  let best: T | null = null;
  for (const t of tiers) if (t.minQuantity <= quantity && (!best || t.minQuantity > best.minQuantity)) best = t;
  return best;
}

/** Whether a product can be ordered now: in season, or before the season opens when pre-orders are allowed. */
export function availability(p: { availableFrom: Date | null; availableUntil: Date | null; allowPreorder: boolean }, now = new Date()) {
  const inSeason = (!p.availableFrom || p.availableFrom <= now) && (!p.availableUntil || p.availableUntil >= now);
  if (inSeason) return { orderable: true, preorder: false };
  const upcoming = Boolean(p.availableFrom && p.availableFrom > now);
  return { orderable: upcoming && p.allowPreorder, preorder: upcoming && p.allowPreorder };
}
