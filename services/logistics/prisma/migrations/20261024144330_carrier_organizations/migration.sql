-- CreateEnum
CREATE TYPE "CarrierStatus" AS ENUM ('none', 'requested', 'accepted', 'declined');

-- AlterTable
ALTER TABLE "carriers" ADD COLUMN     "carrier_organization_id" UUID;

-- AlterTable
ALTER TABLE "shipments" ADD COLUMN     "carrier_note" TEXT,
ADD COLUMN     "carrier_organization_id" UUID,
ADD COLUMN     "carrier_status" "CarrierStatus" NOT NULL DEFAULT 'none';

-- CreateIndex
CREATE INDEX "shipments_carrier_organization_id_carrier_status_idx" ON "shipments"("carrier_organization_id", "carrier_status");
