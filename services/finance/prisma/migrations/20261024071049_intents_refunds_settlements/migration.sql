-- CreateEnum
CREATE TYPE "IntentStatus" AS ENUM ('pending', 'succeeded', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('requested', 'approved', 'processing', 'succeeded', 'failed', 'rejected');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('pending', 'paid');

-- CreateTable
CREATE TABLE "payment_intents" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_ref" TEXT NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "IntentStatus" NOT NULL DEFAULT 'pending',
    "checkout_url" TEXT,
    "fee" DECIMAL(18,4),
    "failure_reason" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "seller_organization_id" UUID NOT NULL,
    "buyer_organization_id" UUID NOT NULL,
    "invoice_id" UUID,
    "order_id" UUID,
    "return_id" UUID,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'requested',
    "method" TEXT,
    "provider" TEXT,
    "provider_ref" TEXT,
    "failure_reason" TEXT,
    "requested_by_user_id" UUID,
    "approved_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlements" (
    "id" UUID NOT NULL,
    "seller_organization_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "period_start" TIMESTAMPTZ(3) NOT NULL,
    "period_end" TIMESTAMPTZ(3) NOT NULL,
    "payment_count" INTEGER NOT NULL,
    "gross_amount" DECIMAL(18,4) NOT NULL,
    "fee_total" DECIMAL(18,4) NOT NULL,
    "refund_total" DECIMAL(18,4) NOT NULL,
    "net_amount" DECIMAL(18,4) NOT NULL,
    "status" "SettlementStatus" NOT NULL DEFAULT 'pending',
    "payout_ref" TEXT,
    "paid_at" TIMESTAMPTZ(3),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_intents_invoice_id_created_at_idx" ON "payment_intents"("invoice_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_intents_provider_provider_ref_key" ON "payment_intents"("provider", "provider_ref");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_number_key" ON "refunds"("number");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_return_id_key" ON "refunds"("return_id");

-- CreateIndex
CREATE INDEX "refunds_seller_organization_id_status_idx" ON "refunds"("seller_organization_id", "status");

-- CreateIndex
CREATE INDEX "refunds_buyer_organization_id_status_idx" ON "refunds"("buyer_organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "settlements_seller_organization_id_provider_currency_period_key" ON "settlements"("seller_organization_id", "provider", "currency", "period_start", "period_end");

-- AddForeignKey
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
