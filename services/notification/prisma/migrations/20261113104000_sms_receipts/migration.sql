-- PRD v2.0 NTF-02: SMS delivery receipts and cost tracking.
ALTER TABLE "delivery_attempts" ADD COLUMN "provider_message_id" TEXT;
ALTER TABLE "delivery_attempts" ADD COLUMN "segments" INTEGER;
ALTER TABLE "delivery_attempts" ADD COLUMN "cost" DECIMAL(12,4);
ALTER TABLE "delivery_attempts" ADD COLUMN "receipt_status" TEXT;
ALTER TABLE "delivery_attempts" ADD COLUMN "receipt_at" TIMESTAMPTZ(3);
CREATE UNIQUE INDEX "delivery_attempts_provider_provider_message_id_key" ON "delivery_attempts"("provider", "provider_message_id");
