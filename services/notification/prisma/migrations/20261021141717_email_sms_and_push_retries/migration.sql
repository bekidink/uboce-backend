-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "attempt_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "next_attempt_at" TIMESTAMPTZ(3),
ADD COLUMN     "recipient" TEXT,
ALTER COLUMN "user_id" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "notifications_channel_status_next_attempt_at_idx" ON "notifications"("channel", "status", "next_attempt_at");
