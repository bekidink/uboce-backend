-- CreateTable
CREATE TABLE "activity_events" (
    "event_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "area" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "reference" TEXT,
    "aggregate_id" TEXT NOT NULL,
    "branch_id" UUID,
    "actor_user_id" UUID,
    "own" BOOLEAN NOT NULL DEFAULT true,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "data" JSONB NOT NULL,

    CONSTRAINT "activity_events_pkey" PRIMARY KEY ("event_id","organization_id")
);

-- CreateTable
CREATE TABLE "report_templates" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "dataset" TEXT NOT NULL,
    "columns" TEXT[],
    "filters" JSONB NOT NULL DEFAULT '{}',
    "format" TEXT NOT NULL DEFAULT 'csv',
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "report_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "activity_events_organization_id_occurred_at_idx" ON "activity_events"("organization_id", "occurred_at");

-- CreateIndex
CREATE INDEX "activity_events_organization_id_area_occurred_at_idx" ON "activity_events"("organization_id", "area", "occurred_at");

-- CreateIndex
CREATE INDEX "activity_events_organization_id_branch_id_occurred_at_idx" ON "activity_events"("organization_id", "branch_id", "occurred_at");

-- CreateIndex
CREATE INDEX "report_templates_organization_id_idx" ON "report_templates"("organization_id");
