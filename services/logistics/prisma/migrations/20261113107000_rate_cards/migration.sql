-- PRD v2.0 LOG-06: versioned seller delivery rate cards.
CREATE TABLE "rate_cards" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "version" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "free_over_amount" DECIMAL(18,4),
    "zones" JSONB NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "rate_cards_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "rate_cards_organization_id_currency_version_key" ON "rate_cards"("organization_id", "currency", "version");
-- One live card per seller and currency.
CREATE UNIQUE INDEX "rate_cards_one_active" ON "rate_cards"("organization_id", "currency") WHERE "active";
