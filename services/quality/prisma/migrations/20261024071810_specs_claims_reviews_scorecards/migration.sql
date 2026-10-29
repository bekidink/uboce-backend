-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('open', 'accepted', 'rejected', 'escalated', 'resolved');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('pending', 'published', 'hidden', 'rejected');

-- CreateTable
CREATE TABLE "quality_specs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "parameters" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quality_specs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certifications" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "product_id" UUID,
    "kind" TEXT NOT NULL,
    "certificate_number" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3),
    "document_id" UUID,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "certifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_claims" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "order_id" UUID NOT NULL,
    "order_line_id" UUID,
    "order_number" TEXT NOT NULL,
    "buyer_organization_id" UUID NOT NULL,
    "supplier_organization_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "affected_quantity" DECIMAL(18,4),
    "evidence_document_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "status" "ClaimStatus" NOT NULL DEFAULT 'open',
    "resolution" TEXT,
    "supplier_response" TEXT,
    "opened_by_user_id" UUID NOT NULL,
    "responded_by_user_id" UUID,
    "responded_at" TIMESTAMPTZ(3),
    "resolved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "quality_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "reviewer_organization_id" UUID NOT NULL,
    "reviewer_user_id" UUID NOT NULL,
    "subject_organization_id" UUID NOT NULL,
    "product_id" UUID,
    "subject_key" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "title" TEXT,
    "body" TEXT,
    "status" "ReviewStatus" NOT NULL DEFAULT 'published',
    "moderation_note" TEXT,
    "moderated_by_user_id" UUID,
    "supplier_reply" TEXT,
    "replied_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scorecard_snapshots" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "period" TEXT NOT NULL,
    "inspections" INTEGER NOT NULL,
    "inspections_passed" INTEGER NOT NULL,
    "nonconformances" INTEGER NOT NULL,
    "claims_opened" INTEGER NOT NULL,
    "claims_accepted" INTEGER NOT NULL,
    "review_count" INTEGER NOT NULL,
    "average_rating" DECIMAL(3,2),
    "score" DECIMAL(5,2) NOT NULL,
    "formula_version" INTEGER NOT NULL,
    "computed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scorecard_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quality_specs_organization_id_active_idx" ON "quality_specs"("organization_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "quality_specs_product_id_version_key" ON "quality_specs"("product_id", "version");

-- CreateIndex
CREATE INDEX "certifications_organization_id_idx" ON "certifications"("organization_id");

-- CreateIndex
CREATE INDEX "certifications_product_id_idx" ON "certifications"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "quality_claims_number_key" ON "quality_claims"("number");

-- CreateIndex
CREATE INDEX "quality_claims_buyer_organization_id_status_idx" ON "quality_claims"("buyer_organization_id", "status");

-- CreateIndex
CREATE INDEX "quality_claims_supplier_organization_id_status_idx" ON "quality_claims"("supplier_organization_id", "status");

-- CreateIndex
CREATE INDEX "reviews_subject_organization_id_status_idx" ON "reviews"("subject_organization_id", "status");

-- CreateIndex
CREATE INDEX "reviews_product_id_status_idx" ON "reviews"("product_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_order_id_reviewer_organization_id_subject_key_key" ON "reviews"("order_id", "reviewer_organization_id", "subject_key");

-- CreateIndex
CREATE UNIQUE INDEX "scorecard_snapshots_organization_id_period_key" ON "scorecard_snapshots"("organization_id", "period");
