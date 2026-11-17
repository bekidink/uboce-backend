-- PRD v2.0 ORD-03: quotations expire and stale RFQs close on schedule.
ALTER TYPE "QuotationStatus" ADD VALUE IF NOT EXISTS 'expired';
ALTER TYPE "RfqStatus" ADD VALUE IF NOT EXISTS 'closed';
CREATE INDEX IF NOT EXISTS "quotations_status_valid_until_idx" ON "quotations"("status", "valid_until");
