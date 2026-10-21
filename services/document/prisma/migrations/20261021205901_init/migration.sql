-- CreateEnum
CREATE TYPE "DocumentClassification" AS ENUM ('identity_document', 'business_registration', 'license', 'tax_certificate', 'delivery_evidence', 'inspection_evidence', 'dispute_evidence', 'invoice', 'product_image', 'other');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('pending_upload', 'available', 'rejected', 'deleted');

-- CreateEnum
CREATE TYPE "GranteeType" AS ENUM ('organization', 'user', 'case');

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "owner_organization_id" UUID,
    "classification" "DocumentClassification" NOT NULL,
    "file_name" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "declared_size" INTEGER NOT NULL,
    "size_bytes" INTEGER,
    "sha256" TEXT,
    "storage_key" TEXT NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'pending_upload',
    "rejection_reason" TEXT,
    "retention_until" TIMESTAMPTZ(3),
    "legal_hold" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploaded_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_grants" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "grantee_type" "GranteeType" NOT NULL,
    "grantee_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "granted_by" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_access_log" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "actor_user_id" UUID,
    "actor_service" TEXT,
    "organization_id" UUID,
    "ip_address" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_access_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "documents_storage_key_key" ON "documents"("storage_key");

-- CreateIndex
CREATE INDEX "documents_owner_organization_id_classification_idx" ON "documents"("owner_organization_id", "classification");

-- CreateIndex
CREATE INDEX "documents_owner_user_id_idx" ON "documents"("owner_user_id");

-- CreateIndex
CREATE INDEX "document_grants_document_id_grantee_type_grantee_id_idx" ON "document_grants"("document_id", "grantee_type", "grantee_id");

-- CreateIndex
CREATE INDEX "document_access_log_document_id_created_at_idx" ON "document_access_log"("document_id", "created_at");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_created_at_idx" ON "outbox_events"("published_at", "created_at");

-- AddForeignKey
ALTER TABLE "document_grants" ADD CONSTRAINT "document_grants_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_access_log" ADD CONSTRAINT "document_access_log_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
