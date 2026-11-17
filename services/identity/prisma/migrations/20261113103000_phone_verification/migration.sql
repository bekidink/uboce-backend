-- PRD v2.0 ORG-01, NTF-03: verified phone numbers and SMS codes.

ALTER TABLE "users" ADD COLUMN "phone_verified_at" TIMESTAMPTZ(3);

CREATE TYPE "PhonePurpose" AS ENUM ('verify', 'login');

CREATE TABLE "phone_verifications" (
    "id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "purpose" "PhonePurpose" NOT NULL,
    "user_id" UUID,
    "code_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "ip_address" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "phone_verifications_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "phone_verifications_phone_purpose_created_at_idx" ON "phone_verifications"("phone", "purpose", "created_at");
CREATE INDEX "phone_verifications_expires_at_idx" ON "phone_verifications"("expires_at");
ALTER TABLE "phone_verifications" ADD CONSTRAINT "phone_verifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
