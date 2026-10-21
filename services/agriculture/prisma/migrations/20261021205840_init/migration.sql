-- CreateEnum
CREATE TYPE "CroppingSeason" AS ENUM ('meher', 'belg', 'irrigated');

-- CreateEnum
CREATE TYPE "LotStatus" AS ENUM ('active', 'depleted');

-- CreateTable
CREATE TABLE "farms" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "member_user_id" UUID,
    "region" TEXT,
    "zone" TEXT,
    "woreda" TEXT,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "area_hectares" DECIMAL(10,2),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "farms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "farm_plots" (
    "id" UUID NOT NULL,
    "farm_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "area_hectares" DECIMAL(10,2),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "farm_plots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_seasons" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "farm_id" UUID NOT NULL,
    "plot_id" UUID,
    "crop" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "season" "CroppingSeason" NOT NULL,
    "planted_at" TIMESTAMPTZ(3),
    "expected_harvest_quantity" DECIMAL(18,4),
    "unit_of_measure" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_seasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "harvest_records" (
    "id" UUID NOT NULL,
    "season_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "harvested_at" TIMESTAMPTZ(3) NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit_of_measure" TEXT NOT NULL,
    "notes" TEXT,
    "recorded_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "harvest_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "produce_lots" (
    "id" UUID NOT NULL,
    "lot_code" TEXT NOT NULL,
    "organization_id" UUID NOT NULL,
    "crop" TEXT NOT NULL,
    "product_id" UUID,
    "quantity" DECIMAL(18,4) NOT NULL,
    "original_quantity" DECIMAL(18,4) NOT NULL,
    "unit_of_measure" TEXT NOT NULL,
    "grade" TEXT,
    "warehouse_id" UUID,
    "status" "LotStatus" NOT NULL DEFAULT 'active',
    "origin" TEXT NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "produce_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lot_sources" (
    "id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "parent_lot_id" UUID,
    "harvest_id" UUID,
    "quantity" DECIMAL(18,4) NOT NULL,

    CONSTRAINT "lot_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grading_records" (
    "id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "grade" TEXT NOT NULL,
    "moisture_pct" DECIMAL(5,2),
    "defect_count" INTEGER,
    "notes" TEXT,
    "graded_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grading_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_postings" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit_of_measure" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "posted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_postings_pkey" PRIMARY KEY ("id")
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
CREATE INDEX "farms_organization_id_idx" ON "farms"("organization_id");

-- CreateIndex
CREATE INDEX "production_seasons_organization_id_year_idx" ON "production_seasons"("organization_id", "year");

-- CreateIndex
CREATE INDEX "harvest_records_organization_id_idx" ON "harvest_records"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "produce_lots_lot_code_key" ON "produce_lots"("lot_code");

-- CreateIndex
CREATE INDEX "produce_lots_organization_id_status_idx" ON "produce_lots"("organization_id", "status");

-- CreateIndex
CREATE INDEX "lot_sources_lot_id_idx" ON "lot_sources"("lot_id");

-- CreateIndex
CREATE INDEX "lot_sources_parent_lot_id_idx" ON "lot_sources"("parent_lot_id");

-- CreateIndex
CREATE INDEX "lot_sources_harvest_id_idx" ON "lot_sources"("harvest_id");

-- CreateIndex
CREATE INDEX "grading_records_lot_id_idx" ON "grading_records"("lot_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_postings_idempotency_key_key" ON "stock_postings"("idempotency_key");

-- CreateIndex
CREATE INDEX "stock_postings_posted_at_created_at_idx" ON "stock_postings"("posted_at", "created_at");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_created_at_idx" ON "outbox_events"("published_at", "created_at");

-- AddForeignKey
ALTER TABLE "farm_plots" ADD CONSTRAINT "farm_plots_farm_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_seasons" ADD CONSTRAINT "production_seasons_farm_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "harvest_records" ADD CONSTRAINT "harvest_records_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "production_seasons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lot_sources" ADD CONSTRAINT "lot_sources_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "produce_lots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grading_records" ADD CONSTRAINT "grading_records_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "produce_lots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
