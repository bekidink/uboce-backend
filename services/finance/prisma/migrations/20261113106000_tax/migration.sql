-- PRD v2.0 FIN-09: tax rules as data, seller tax profiles, buyer exemptions.

CREATE TABLE "tax_rules" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "regime" TEXT NOT NULL,
    "tax_class" TEXT NOT NULL,
    "rate_pct" DECIMAL(5,2) NOT NULL,
    "effective_from" TIMESTAMPTZ(3) NOT NULL,
    "effective_to" TIMESTAMPTZ(3),
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tax_rules_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "tax_rules_regime_tax_class_effective_from_idx" ON "tax_rules"("regime", "tax_class", "effective_from");

-- Starting rules (Ethiopia): VAT 15%, zero-rated 0%; turnover tax 2% on goods, 10% on services.
-- Confirm with an accountant before launch; change rates by adding rules, not editing these.
INSERT INTO "tax_rules" ("id", "code", "name", "regime", "tax_class", "rate_pct", "effective_from") VALUES
  ('8f1c2a5e-0001-4a6b-9c1d-000000000001', 'VAT', 'Value added tax', 'vat', 'standard', 15.00, '2002-07-08T00:00:00Z'),
  ('8f1c2a5e-0001-4a6b-9c1d-000000000002', 'VAT', 'Value added tax, zero-rated', 'vat', 'zero_rated', 0.00, '2002-07-08T00:00:00Z'),
  ('8f1c2a5e-0001-4a6b-9c1d-000000000003', 'VAT', 'Value added tax on services', 'vat', 'service', 15.00, '2002-07-08T00:00:00Z'),
  ('8f1c2a5e-0001-4a6b-9c1d-000000000004', 'TOT', 'Turnover tax on goods', 'tot', 'standard', 2.00, '2002-07-08T00:00:00Z'),
  ('8f1c2a5e-0001-4a6b-9c1d-000000000005', 'TOT', 'Turnover tax on services', 'tot', 'service', 10.00, '2002-07-08T00:00:00Z'),
  ('8f1c2a5e-0001-4a6b-9c1d-000000000006', 'TOT', 'Turnover tax, zero-rated goods', 'tot', 'zero_rated', 0.00, '2002-07-08T00:00:00Z');

CREATE TABLE "seller_tax_profiles" (
    "organization_id" UUID NOT NULL,
    "regime" TEXT NOT NULL DEFAULT 'none',
    "tin" TEXT,
    "vat_number" TEXT,
    "legal_name" TEXT,
    "prices_include_tax" BOOLEAN NOT NULL DEFAULT false,
    "updated_by_user_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "seller_tax_profiles_pkey" PRIMARY KEY ("organization_id")
);

CREATE TYPE "ExemptionStatus" AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE "tax_exemptions" (
    "id" UUID NOT NULL,
    "buyer_organization_id" UUID NOT NULL,
    "certificate_number" TEXT NOT NULL,
    "document_id" UUID NOT NULL,
    "valid_from" TIMESTAMPTZ(3) NOT NULL,
    "valid_to" TIMESTAMPTZ(3) NOT NULL,
    "status" "ExemptionStatus" NOT NULL DEFAULT 'pending',
    "review_note" TEXT,
    "submitted_by_user_id" UUID NOT NULL,
    "reviewed_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "tax_exemptions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "tax_exemptions_buyer_organization_id_status_idx" ON "tax_exemptions"("buyer_organization_id", "status");
