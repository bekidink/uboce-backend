-- CreateTable
CREATE TABLE "cart_items" (
    "id" UUID NOT NULL,
    "buyer_organization_id" UUID NOT NULL,
    "supplier_organization_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "variant_id" UUID NOT NULL,
    "option_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "options_key" TEXT NOT NULL DEFAULT '',
    "quantity" DECIMAL(18,4) NOT NULL,
    "added_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cart_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cart_items_buyer_organization_id_variant_id_options_key_key" ON "cart_items"("buyer_organization_id", "variant_id", "options_key");

-- CreateIndex
CREATE INDEX "cart_items_buyer_organization_id_supplier_organization_id_idx" ON "cart_items"("buyer_organization_id", "supplier_organization_id");
