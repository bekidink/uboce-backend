import { Prisma } from '../generated/prisma/client.js';

// Inspection result rules (PRD 5.14), without I/O.

const { Decimal } = Prisma;

export interface ResultLine {
  itemId: string;
  inspectedQuantity: Prisma.Decimal;
  acceptedQuantity: string;
  rejectedQuantity: string;
}

/**
 * Every inspected unit must be either accepted or rejected, and the overall
 * decision must agree with the numbers: "accepted" means nothing rejected,
 * "rejected" means nothing accepted.
 */
export function validateResults(decision: string, lines: ResultLine[]): string | null {
  for (const l of lines) {
    const accepted = new Decimal(l.acceptedQuantity);
    const rejected = new Decimal(l.rejectedQuantity);
    if (!accepted.plus(rejected).equals(l.inspectedQuantity)) {
      return `Item ${l.itemId}: accepted + rejected must equal the ${l.inspectedQuantity.toString()} inspected`;
    }
  }
  const anyAccepted = lines.some((l) => new Decimal(l.acceptedQuantity).greaterThan(0));
  const anyRejected = lines.some((l) => new Decimal(l.rejectedQuantity).greaterThan(0));
  if (decision === 'accepted' && anyRejected) return 'A fully accepted inspection cannot reject quantities; use conditionally_accepted';
  if (decision === 'rejected' && anyAccepted) return 'A rejected inspection cannot accept quantities; use conditionally_accepted';
  if (decision === 'conditionally_accepted' && !(anyAccepted && anyRejected)) {
    return 'Conditional acceptance needs some quantity accepted and some rejected';
  }
  return null;
}
