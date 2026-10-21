-- CreateEnum
CREATE TYPE "SubjectType" AS ENUM ('order', 'shipment', 'inspection', 'invoice');

-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('open', 'under_review', 'resolved', 'withdrawn');

-- CreateEnum
CREATE TYPE "Outcome" AS ENUM ('in_favor_of_opener', 'in_favor_of_respondent', 'shared_responsibility', 'no_fault_found');

-- CreateTable
CREATE TABLE "disputes" (
    "id" UUID NOT NULL,
    "subject_type" "SubjectType" NOT NULL,
    "subject_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "opened_by_organization_id" UUID NOT NULL,
    "against_organization_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "DisputeStatus" NOT NULL DEFAULT 'open',
    "reviewer_user_id" UUID,
    "outcome" "Outcome",
    "resolution_summary" TEXT,
    "follow_up_actions" TEXT,
    "appeal_of_dispute_id" UUID,
    "opened_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),

    CONSTRAINT "disputes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispute_statements" (
    "id" UUID NOT NULL,
    "dispute_id" UUID NOT NULL,
    "organization_id" UUID,
    "author_user_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "evidence_document_ids" UUID[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispute_statements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_facts" (
    "id" UUID NOT NULL,
    "supplier_organization_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "source_event_id" UUID NOT NULL,

    CONSTRAINT "supplier_facts_pkey" PRIMARY KEY ("id")
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

-- CreateTable
CREATE TABLE "processed_events" (
    "event_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "disputes_appeal_of_dispute_id_key" ON "disputes"("appeal_of_dispute_id");

-- CreateIndex
CREATE INDEX "disputes_opened_by_organization_id_status_idx" ON "disputes"("opened_by_organization_id", "status");

-- CreateIndex
CREATE INDEX "disputes_against_organization_id_status_idx" ON "disputes"("against_organization_id", "status");

-- CreateIndex
CREATE INDEX "disputes_status_created_at_idx" ON "disputes"("status", "created_at");

-- CreateIndex
CREATE INDEX "dispute_statements_dispute_id_created_at_idx" ON "dispute_statements"("dispute_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_facts_source_event_id_key" ON "supplier_facts"("source_event_id");

-- CreateIndex
CREATE INDEX "supplier_facts_supplier_organization_id_kind_occurred_at_idx" ON "supplier_facts"("supplier_organization_id", "kind", "occurred_at");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_created_at_idx" ON "outbox_events"("published_at", "created_at");

-- AddForeignKey
ALTER TABLE "dispute_statements" ADD CONSTRAINT "dispute_statements_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "disputes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
