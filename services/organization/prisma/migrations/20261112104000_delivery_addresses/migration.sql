-- CreateTable
CREATE TABLE "delivery_addresses" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "recipient_name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "city" TEXT NOT NULL,
    "region" TEXT,
    "country_code" CHAR(2) NOT NULL DEFAULT 'ET',
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "instructions" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "delivery_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "delivery_addresses_organization_id_idx" ON "delivery_addresses"("organization_id");

-- AddForeignKey
ALTER TABLE "delivery_addresses" ADD CONSTRAINT "delivery_addresses_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
