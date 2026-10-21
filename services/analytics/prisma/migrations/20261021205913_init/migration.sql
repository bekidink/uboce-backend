-- CreateTable
CREATE TABLE "daily_metrics" (
    "organization_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "metric" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT '',
    "value" DECIMAL(20,4) NOT NULL,

    CONSTRAINT "daily_metrics_pkey" PRIMARY KEY ("organization_id","day","metric","currency")
);

-- CreateTable
CREATE TABLE "index_state" (
    "id" TEXT NOT NULL,
    "last_event_occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "last_indexed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "index_state_pkey" PRIMARY KEY ("id")
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
CREATE INDEX "daily_metrics_organization_id_metric_day_idx" ON "daily_metrics"("organization_id", "metric", "day");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_created_at_idx" ON "outbox_events"("published_at", "created_at");
