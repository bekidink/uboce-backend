// KYC policy (PRD 5.3, 9.1). Collect only what each tier needs. Tiers, evidence
// and validity are PLACEHOLDERS pending compliance review (PRD §17), versioned so
// every decision records the policy it was made under.

export const POLICY_VERSION = 'kyc-2026.1';

export const SUBJECT_KIND = 'user';
export const EVENT_TYPE = 'KycVerificationDecided' as const;

/** Requirement → the document classification accepted as evidence for it. */
export const TIERS: Record<string, Record<string, string>> = {
  basic: { national_id: 'identity_document' },
  enhanced: { national_id: 'identity_document', proof_of_address: 'other' },
};

/** How long an approval stays valid before re-verification. */
export const VALIDITY_DAYS = 730;
