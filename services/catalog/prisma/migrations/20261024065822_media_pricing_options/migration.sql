-- AlterTable
ALTER TABLE "categories" ADD COLUMN     "attribute_definitions" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "product_variants" ADD COLUMN     "barcode" TEXT,
ADD COLUMN     "pack_size" DECIMAL(18,4),
ADD COLUMN     "shelf_life_days" INTEGER,
ADD COLUMN     "tracks_batches" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tracks_expiry" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "allow_preorder" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "available_from" TIMESTAMPTZ(3),
ADD COLUMN     "available_until" TIMESTAMPTZ(3),
ADD COLUMN     "lead_time_days" INTEGER,
ADD COLUMN     "made_to_order" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "product_media" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "alt_text" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "variant_price_tiers" (
    "id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "min_quantity" DECIMAL(18,4) NOT NULL,
    "unit_price" DECIMAL(18,4) NOT NULL,

    CONSTRAINT "variant_price_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_option_groups" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "multiple" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL,

    CONSTRAINT "product_option_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_options" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "price_delta" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL,

    CONSTRAINT "product_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_lists" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "buyer_organization_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "branch_id" UUID,
    "starts_at" TIMESTAMPTZ(3),
    "ends_at" TIMESTAMPTZ(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "price_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_list_entries" (
    "id" UUID NOT NULL,
    "price_list_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "min_quantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "unit_price" DECIMAL(18,4) NOT NULL,

    CONSTRAINT "price_list_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_media_product_id_position_idx" ON "product_media"("product_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "product_media_product_id_document_id_key" ON "product_media"("product_id", "document_id");

-- CreateIndex
CREATE UNIQUE INDEX "variant_price_tiers_variant_id_min_quantity_key" ON "variant_price_tiers"("variant_id", "min_quantity");

-- CreateIndex
CREATE INDEX "product_option_groups_product_id_idx" ON "product_option_groups"("product_id");

-- CreateIndex
CREATE INDEX "price_lists_organization_id_active_idx" ON "price_lists"("organization_id", "active");

-- CreateIndex
CREATE INDEX "price_list_entries_variant_id_idx" ON "price_list_entries"("variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "price_list_entries_price_list_id_variant_id_min_quantity_key" ON "price_list_entries"("price_list_id", "variant_id", "min_quantity");

-- AddForeignKey
ALTER TABLE "product_media" ADD CONSTRAINT "product_media_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_price_tiers" ADD CONSTRAINT "variant_price_tiers_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_option_groups" ADD CONSTRAINT "product_option_groups_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_options" ADD CONSTRAINT "product_options_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "product_option_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_list_entries" ADD CONSTRAINT "price_list_entries_price_list_id_fkey" FOREIGN KEY ("price_list_id") REFERENCES "price_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_list_entries" ADD CONSTRAINT "price_list_entries_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
