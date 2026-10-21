-- CreateEnum
CREATE TYPE "CaseStatus" AS ENUM ('draft', 'submitted', 'in_review', 'needs_information', 'approved', 'rejected', 'suspended', 'expired');

-- CreateTable
CREATE TABLE "verification_cases" (
    "id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "tier" TEXT NOT NULL,
    "policy_version" TEXT NOT NULL,
    "status" "CaseStatus" NOT NULL DEFAULT 'draft',
    "reviewer_user_id" UUID,
    "reason_code" TEXT,
    "submitted_at" TIMESTAMPTZ(3),
    "decided_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "verification_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "case_evidence" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "requirement" TEXT NOT NULL,
    "document_id" UUID NOT NULL,
    "added_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "case_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "case_checks" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "details" TEXT,
    "performed_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "case_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "case_decisions" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "from_status" "CaseStatus",
    "to_status" "CaseStatus" NOT NULL,
    "reason_code" TEXT,
    "internal_notes" TEXT,
    "actor_user_id" UUID,
    "policy_version" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "case_decisions_pkey" PRIMARY KEY ("id")
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
CREATE INDEX "verification_cases_subject_id_status_idx" ON "verification_cases"("subject_id", "status");

-- CreateIndex
CREATE INDEX "verification_cases_status_submitted_at_idx" ON "verification_cases"("status", "submitted_at");

-- CreateIndex
CREATE UNIQUE INDEX "case_evidence_case_id_requirement_key" ON "case_evidence"("case_id", "requirement");

-- CreateIndex
CREATE INDEX "case_checks_case_id_idx" ON "case_checks"("case_id");

-- CreateIndex
CREATE INDEX "case_decisions_case_id_created_at_idx" ON "case_decisions"("case_id", "created_at");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_created_at_idx" ON "outbox_events"("published_at", "created_at");

-- AddForeignKey
ALTER TABLE "case_evidence" ADD CONSTRAINT "case_evidence_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "verification_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_checks" ADD CONSTRAINT "case_checks_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "verification_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_decisions" ADD CONSTRAINT "case_decisions_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "verification_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
