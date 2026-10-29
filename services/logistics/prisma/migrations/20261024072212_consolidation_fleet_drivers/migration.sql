-- CreateEnum
CREATE TYPE "FreightPayer" AS ENUM ('shipper', 'consignee', 'third_party');

-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('assigned', 'accepted', 'completed', 'cancelled');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ShipmentStatus" ADD VALUE 'assigned';
ALTER TYPE "ShipmentStatus" ADD VALUE 'ready_for_pickup';
ALTER TYPE "ShipmentStatus" ADD VALUE 'picked_up';
ALTER TYPE "ShipmentStatus" ADD VALUE 'delayed';

-- AlterTable
ALTER TABLE "shipment_items" ADD COLUMN     "order_id" UUID;

-- AlterTable
ALTER TABLE "shipments" ADD COLUMN     "carrier_id" UUID,
ADD COLUMN     "freight_cost" DECIMAL(18,4),
ADD COLUMN     "freight_currency" CHAR(3),
ADD COLUMN     "freight_payer" "FreightPayer" NOT NULL DEFAULT 'shipper',
ADD COLUMN     "incoterm" TEXT,
ADD COLUMN     "pickup_window_end" TIMESTAMPTZ(3),
ADD COLUMN     "pickup_window_start" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "shipment_orders" (
    "shipment_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_number" TEXT NOT NULL,

    CONSTRAINT "shipment_orders_pkey" PRIMARY KEY ("shipment_id","order_id")
);

-- CreateTable
CREATE TABLE "shipment_packages" (
    "id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "weight_kg" DECIMAL(12,3),
    "length_cm" DECIMAL(10,2),
    "width_cm" DECIMAL(10,2),
    "height_cm" DECIMAL(10,2),
    "contents" TEXT,

    CONSTRAINT "shipment_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carriers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "phone" TEXT,
    "tracking_provider" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "carriers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicles" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plate_number" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "capacity_kg" DECIMAL(12,2),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drivers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "license_number" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drivers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_assignments" (
    "id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "vehicle_id" UUID,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'assigned',
    "assigned_by_user_id" UUID NOT NULL,
    "assigned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "driver_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shipment_orders_order_id_idx" ON "shipment_orders"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_packages_shipment_id_reference_key" ON "shipment_packages"("shipment_id", "reference");

-- CreateIndex
CREATE INDEX "carriers_organization_id_idx" ON "carriers"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_organization_id_plate_number_key" ON "vehicles"("organization_id", "plate_number");

-- CreateIndex
CREATE INDEX "drivers_organization_id_idx" ON "drivers"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "drivers_organization_id_user_id_key" ON "drivers"("organization_id", "user_id");

-- CreateIndex
CREATE INDEX "driver_assignments_driver_id_status_idx" ON "driver_assignments"("driver_id", "status");

-- CreateIndex
CREATE INDEX "driver_assignments_shipment_id_idx" ON "driver_assignments"("shipment_id");

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_carrier_id_fkey" FOREIGN KEY ("carrier_id") REFERENCES "carriers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_orders" ADD CONSTRAINT "shipment_orders_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_packages" ADD CONSTRAINT "shipment_packages_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_assignments" ADD CONSTRAINT "driver_assignments_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_assignments" ADD CONSTRAINT "driver_assignments_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_assignments" ADD CONSTRAINT "driver_assignments_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
