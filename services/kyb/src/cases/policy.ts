// KYB policy (PRD 5.4, 9.1). Evidence is limited to what business verification
// needs. Tiers and validity are PLACEHOLDERS pending compliance review (PRD §17);
// the version is recorded on every decision.

export const POLICY_VERSION = 'kyb-2026.1';

export const SUBJECT_KIND = 'organization';
export const EVENT_TYPE = 'KybVerificationDecided' as const;

/** Requirement → the document classification accepted as evidence for it. */
export const TIERS: Record<string, Record<string, string>> = {
  standard: {
    business_registration: 'business_registration',
    trade_license: 'license',
    tax_registration: 'tax_certificate',
    representative_id: 'identity_document',
  },
};

/** Business verification is renewed yearly. */
export const VALIDITY_DAYS = 365;
