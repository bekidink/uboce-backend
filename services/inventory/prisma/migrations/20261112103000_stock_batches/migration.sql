-- AlterTable
ALTER TABLE "stock_movements" ADD COLUMN     "batch_code" TEXT,
ADD COLUMN     "expires_on" DATE;

-- CreateTable
CREATE TABLE "stock_batches" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "batch_code" TEXT NOT NULL,
    "expires_on" DATE,
    "on_hand" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stock_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stock_batches_organization_id_warehouse_id_item_id_batch_code_key" ON "stock_batches"("organization_id", "warehouse_id", "item_id", "batch_code");

-- CreateIndex
CREATE INDEX "stock_batches_organization_id_expires_on_idx" ON "stock_batches"("organization_id", "expires_on");
