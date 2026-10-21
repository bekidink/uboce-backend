-- CreateEnum
CREATE TYPE "SubjectType" AS ENUM ('receipt', 'produce_lot', 'batch', 'product');

-- CreateEnum
CREATE TYPE "InspectionStatus" AS ENUM ('pending', 'completed');

-- CreateEnum
CREATE TYPE "Decision" AS ENUM ('accepted', 'rejected', 'conditionally_accepted');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('minor', 'major', 'critical');

-- CreateTable
CREATE TABLE "inspections" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "subject_type" "SubjectType" NOT NULL,
    "subject_id" UUID NOT NULL,
    "status" "InspectionStatus" NOT NULL DEFAULT 'pending',
    "decision" "Decision",
    "criteria" JSONB,
    "notes" TEXT,
    "evidence_document_ids" UUID[],
    "inspector_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "inspections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inspection_lines" (
    "id" UUID NOT NULL,
    "inspection_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "inspected_quantity" DECIMAL(18,4) NOT NULL,
    "accepted_quantity" DECIMAL(18,4),
    "rejected_quantity" DECIMAL(18,4),
    "notes" TEXT,

    CONSTRAINT "inspection_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nonconformances" (
    "id" UUID NOT NULL,
    "inspection_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "severity" "Severity" NOT NULL,
    "corrective_action" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "closed_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(3),

    CONSTRAINT "nonconformances_pkey" PRIMARY KEY ("id")
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
CREATE INDEX "inspections_organization_id_status_idx" ON "inspections"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "inspections_subject_type_subject_id_key" ON "inspections"("subject_type", "subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "inspection_lines_inspection_id_item_id_key" ON "inspection_lines"("inspection_id", "item_id");

-- CreateIndex
CREATE INDEX "nonconformances_organization_id_status_idx" ON "nonconformances"("organization_id", "status");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_created_at_idx" ON "outbox_events"("published_at", "created_at");

-- AddForeignKey
ALTER TABLE "inspection_lines" ADD CONSTRAINT "inspection_lines_inspection_id_fkey" FOREIGN KEY ("inspection_id") REFERENCES "inspections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nonconformances" ADD CONSTRAINT "nonconformances_inspection_id_fkey" FOREIGN KEY ("inspection_id") REFERENCES "inspections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
