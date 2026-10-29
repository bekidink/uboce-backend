-- CreateEnum
CREATE TYPE "FulfillmentMethod" AS ENUM ('delivery', 'pickup');

-- CreateEnum
CREATE TYPE "ReturnStatus" AS ENUM ('requested', 'approved', 'rejected', 'received', 'cancelled');

-- CreateEnum
CREATE TYPE "PromotionKind" AS ENUM ('percent', 'fixed');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OrderStatus" ADD VALUE 'ready_for_pickup';
ALTER TYPE "OrderStatus" ADD VALUE 'uncollected';
ALTER TYPE "OrderStatus" ADD VALUE 'delivery_failed';

-- AlterTable
ALTER TABLE "order_lines" ADD COLUMN     "list_price" DECIMAL(18,4),
ADD COLUMN     "price_source" TEXT,
ADD COLUMN     "returned_quantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN     "sku" TEXT,
ADD COLUMN     "snapshot" JSONB,
ADD COLUMN     "variant_id" UUID;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "cancellation_fee" DECIMAL(18,4),
ADD COLUMN     "cancellation_policy" JSONB,
ADD COLUMN     "confirmed_at" TIMESTAMPTZ(3),
ADD COLUMN     "discount_total" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN     "fulfilled_at" TIMESTAMPTZ(3),
ADD COLUMN     "fulfillment_branch_id" UUID,
ADD COLUMN     "fulfillment_method" "FulfillmentMethod" NOT NULL DEFAULT 'delivery',
ADD COLUMN     "preorder" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "promotion_code" TEXT,
ADD COLUMN     "promotion_id" UUID,
ADD COLUMN     "subtotal" DECIMAL(18,4) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "order_fulfillment_changes" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "from_branch_id" UUID,
    "to_branch_id" UUID NOT NULL,
    "changed_by_user_id" UUID NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_fulfillment_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cancellation_policies" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "free_cancellation_hours" INTEGER NOT NULL,
    "cancellation_fee_pct" DECIMAL(5,2) NOT NULL,
    "no_show_fee_pct" DECIMAL(5,2) NOT NULL,
    "return_window_days" INTEGER NOT NULL,
    "restocking_fee_pct" DECIMAL(5,2) NOT NULL,
    "pickup_hold_hours" INTEGER NOT NULL DEFAULT 72,
    "terms" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cancellation_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_requests" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "order_id" UUID NOT NULL,
    "buyer_organization_id" UUID NOT NULL,
    "supplier_organization_id" UUID NOT NULL,
    "status" "ReturnStatus" NOT NULL DEFAULT 'requested',
    "reason" TEXT NOT NULL,
    "lines" JSONB NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "restocking_fee" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "evidence_document_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "requested_by_user_id" UUID NOT NULL,
    "decided_by_user_id" UUID,
    "decision_note" TEXT,
    "decided_at" TIMESTAMPTZ(3),
    "received_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "return_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "kind" "PromotionKind" NOT NULL,
    "value" DECIMAL(18,4) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "min_subtotal" DECIMAL(18,4),
    "max_discount" DECIMAL(18,4),
    "starts_at" TIMESTAMPTZ(3),
    "ends_at" TIMESTAMPTZ(3),
    "usage_limit" INTEGER,
    "per_buyer_limit" INTEGER,
    "used_count" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "promotions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion_redemptions" (
    "id" UUID NOT NULL,
    "promotion_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "buyer_organization_id" UUID NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promotion_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_fulfillment_changes_order_id_created_at_idx" ON "order_fulfillment_changes"("order_id", "created_at");

-- CreateIndex
CREATE INDEX "cancellation_policies_organization_id_active_idx" ON "cancellation_policies"("organization_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "cancellation_policies_organization_id_version_key" ON "cancellation_policies"("organization_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "return_requests_number_key" ON "return_requests"("number");

-- CreateIndex
CREATE INDEX "return_requests_buyer_organization_id_status_idx" ON "return_requests"("buyer_organization_id", "status");

-- CreateIndex
CREATE INDEX "return_requests_supplier_organization_id_status_idx" ON "return_requests"("supplier_organization_id", "status");

-- CreateIndex
CREATE INDEX "promotions_organization_id_active_idx" ON "promotions"("organization_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "promotions_organization_id_code_key" ON "promotions"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_redemptions_order_id_key" ON "promotion_redemptions"("order_id");

-- CreateIndex
CREATE INDEX "promotion_redemptions_promotion_id_buyer_organization_id_idx" ON "promotion_redemptions"("promotion_id", "buyer_organization_id");

-- AddForeignKey
ALTER TABLE "order_fulfillment_changes" ADD CONSTRAINT "order_fulfillment_changes_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "promotions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
