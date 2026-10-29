-- CreateEnum
CREATE TYPE "StockState" AS ENUM ('available', 'damaged', 'quarantined');

-- CreateEnum
CREATE TYPE "CycleCountStatus" AS ENUM ('counting', 'submitted', 'approved', 'cancelled');

-- AlterTable
ALTER TABLE "stock_balances" ADD COLUMN     "damaged" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN     "quarantined" DECIMAL(18,4) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "stock_state_changes" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "from_state" "StockState" NOT NULL,
    "to_state" "StockState" NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "reason" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_state_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cycle_counts" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "organization_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "status" "CycleCountStatus" NOT NULL DEFAULT 'counting',
    "note" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "submitted_by_user_id" UUID,
    "approved_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_at" TIMESTAMPTZ(3),
    "approved_at" TIMESTAMPTZ(3),

    CONSTRAINT "cycle_counts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cycle_count_lines" (
    "id" UUID NOT NULL,
    "cycle_count_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "expected_quantity" DECIMAL(18,4) NOT NULL,
    "counted_quantity" DECIMAL(18,4),
    "note" TEXT,

    CONSTRAINT "cycle_count_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_state_changes_organization_id_item_id_created_at_idx" ON "stock_state_changes"("organization_id", "item_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "cycle_counts_number_key" ON "cycle_counts"("number");

-- CreateIndex
CREATE INDEX "cycle_counts_organization_id_status_idx" ON "cycle_counts"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "cycle_count_lines_cycle_count_id_item_id_key" ON "cycle_count_lines"("cycle_count_id", "item_id");

-- AddForeignKey
ALTER TABLE "cycle_count_lines" ADD CONSTRAINT "cycle_count_lines_cycle_count_id_fkey" FOREIGN KEY ("cycle_count_id") REFERENCES "cycle_counts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
