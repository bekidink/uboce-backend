-- CreateEnum
CREATE TYPE "BusinessModel" AS ENUM ('wholesale', 'retail', 'made_to_order');

-- CreateEnum
CREATE TYPE "LocationKind" AS ENUM ('head_office', 'store', 'warehouse', 'collection_point', 'production_site');

-- AlterEnum
ALTER TYPE "MembershipStatus" ADD VALUE 'suspended';

-- AlterTable
ALTER TABLE "branches" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "fulfillment" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "kind" "LocationKind" NOT NULL DEFAULT 'store',
ADD COLUMN     "latitude" DECIMAL(9,6),
ADD COLUMN     "longitude" DECIMAL(9,6),
ADD COLUMN     "operating_hours" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "pickup_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "service_areas" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "memberships" ADD COLUMN     "suspended_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "business_models" "BusinessModel"[] DEFAULT ARRAY[]::"BusinessModel"[],
ADD COLUMN     "contact_email" TEXT,
ADD COLUMN     "contact_phone" TEXT;

-- CreateTable
CREATE TABLE "membership_locations" (
    "membership_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_locations_pkey" PRIMARY KEY ("membership_id","branch_id")
);

-- CreateIndex
CREATE INDEX "membership_locations_branch_id_idx" ON "membership_locations"("branch_id");

-- AddForeignKey
ALTER TABLE "membership_locations" ADD CONSTRAINT "membership_locations_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_locations" ADD CONSTRAINT "membership_locations_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

