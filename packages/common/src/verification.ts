// Verification case lifecycle shared by KYC (S03) and KYB (S04), PRD 5.3–5.4.
// Pure rules: the services own their data and decide who may act.

export type CaseStatus =
  | 'draft'
  | 'submitted'
  | 'in_review'
  | 'needs_information'
  | 'approved'
  | 'rejected'
  | 'suspended'
  | 'expired';

export type CaseActor = 'subject' | 'reviewer' | 'system';

const TRANSITIONS: Record<CaseStatus, { to: CaseStatus; by: CaseActor }[]> = {
  draft: [{ to: 'submitted', by: 'subject' }],
  submitted: [{ to: 'in_review', by: 'reviewer' }],
  in_review: [
    { to: 'approved', by: 'reviewer' },
    { to: 'rejected', by: 'reviewer' },
    { to: 'needs_information', by: 'reviewer' },
  ],
  needs_information: [{ to: 'submitted', by: 'subject' }],
  approved: [
    { to: 'suspended', by: 'reviewer' },
    { to: 'expired', by: 'system' },
  ],
  suspended: [
    { to: 'approved', by: 'reviewer' },
    { to: 'rejected', by: 'reviewer' },
  ],
  // Final: re-verification is a new case, so the history of this one stays intact.
  rejected: [],
  expired: [],
};

export const canTransitionCase = (from: CaseStatus, to: CaseStatus, by: CaseActor) =>
  TRANSITIONS[from].some((t) => t.to === to && t.by === by);

/** Statuses in which a subject may not open another case. */
export const OPEN_CASE_STATUSES: CaseStatus[] = ['draft', 'submitted', 'in_review', 'needs_information', 'approved', 'suspended'];

/** Requirements of a tier that have no evidence attached yet. */
export const missingRequirements = (required: readonly string[], provided: readonly string[]) =>
  required.filter((r) => !provided.includes(r));

/** What the subject should do next — shown instead of internal reviewer notes (PRD 6.1). */
export function nextAction(status: CaseStatus, missing: string[]): string {
  switch (status) {
    case 'draft':
      return missing.length ? `Upload: ${missing.join(', ')}` : 'Submit for review';
    case 'needs_information':
      return 'Provide the requested information and resubmit';
    case 'submitted':
    case 'in_review':
      return 'Wait for review';
    case 'approved':
      return 'None';
    case 'suspended':
      return 'Contact support';
    case 'rejected':
    case 'expired':
      return 'Start a new verification';
  }
}
