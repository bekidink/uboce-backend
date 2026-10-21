// What may be stored, and for how long. Pure functions, tested on their own.

export const ALLOWED_CONTENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export type AllowedContentType = (typeof ALLOWED_CONTENT_TYPES)[number];

/**
 * Checks the file's first bytes against its declared type, so a renamed
 * executable can't be stored as a "PDF" (PRD 5.17: content validation).
 */
export function matchesSignature(contentType: string, head: Buffer): boolean {
  switch (contentType) {
    case 'application/pdf':
      return head.subarray(0, 5).toString('latin1') === '%PDF-';
    case 'image/png':
      return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/jpeg':
      return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    default:
      return false;
  }
}

/**
 * Minimum retention by classification, in years. PLACEHOLDERS until legal
 * review (PRD §17: retention requirements per data category); deletion before
 * this date is refused, and legal hold blocks deletion entirely.
 */
export const RETENTION_YEARS: Record<string, number> = {
  identity_document: 5,
  business_registration: 10,
  license: 10,
  tax_certificate: 10,
  invoice: 10,
  delivery_evidence: 7,
  inspection_evidence: 7,
  dispute_evidence: 7,
  product_image: 0,
  other: 0,
};

export function retentionUntil(classification: string, from = new Date()): Date | null {
  const years = RETENTION_YEARS[classification] ?? 0;
  if (years === 0) return null;
  const until = new Date(from);
  until.setUTCFullYear(until.getUTCFullYear() + years);
  return until;
}

/** Safe file name for display and Content-Disposition: no paths, quotes or control characters. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  // oxlint-disable-next-line no-control-regex -- removing control characters is the point
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>|*?:]/g, '_').trim().slice(0, 150);
  return cleaned || 'file';
}
