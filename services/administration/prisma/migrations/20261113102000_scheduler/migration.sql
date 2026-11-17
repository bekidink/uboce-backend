-- PRD v2.0 PLT-02: scheduler job definitions and run records.

CREATE TYPE "JobRunStatus" AS ENUM ('running', 'succeeded', 'failed', 'skipped', 'abandoned');

CREATE TABLE "job_definitions" (
    "name" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "job" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "interval_seconds" INTEGER NOT NULL,
    "timeout_seconds" INTEGER NOT NULL DEFAULT 120,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "next_run_at" TIMESTAMPTZ(3) NOT NULL,
    "locked_until" TIMESTAMPTZ(3),
    "locked_by" TEXT,
    "last_run_at" TIMESTAMPTZ(3),
    "last_status" TEXT,
    "last_error" TEXT,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "alerted_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "job_definitions_pkey" PRIMARY KEY ("name")
);
CREATE INDEX "job_definitions_enabled_next_run_at_idx" ON "job_definitions"("enabled", "next_run_at");

CREATE TABLE "job_runs" (
    "id" UUID NOT NULL,
    "job_name" TEXT NOT NULL,
    "instance" TEXT NOT NULL,
    "status" "JobRunStatus" NOT NULL DEFAULT 'running',
    "processed" INTEGER,
    "detail" JSONB,
    "error" TEXT,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    "duration_ms" INTEGER,
    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "job_runs_job_name_started_at_idx" ON "job_runs"("job_name", "started_at");
CREATE INDEX "job_runs_started_at_idx" ON "job_runs"("started_at");
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_job_name_fkey" FOREIGN KEY ("job_name") REFERENCES "job_definitions"("name") ON DELETE CASCADE ON UPDATE CASCADE;
