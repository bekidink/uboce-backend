-- Typo-tolerant search (PRD addendum 2.11). Installed into this schema so it works with or without a search_path.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- AlterTable
ALTER TABLE "organization_profiles" ADD COLUMN     "pickup_cities" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "rating_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rating_sum" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "service_areas" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "product_listings" ADD COLUMN     "allow_preorder" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "available_from" TIMESTAMPTZ(3),
ADD COLUMN     "available_until" TIMESTAMPTZ(3),
ADD COLUMN     "image_document_id" UUID,
ADD COLUMN     "made_to_order" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "min_order_quantity" DECIMAL(18,4),
ADD COLUMN     "search_text" TEXT;

-- CreateTable
CREATE TABLE "product_stock" (
    "organization_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "on_hand" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "product_stock_pkey" PRIMARY KEY ("organization_id","item_id")
);


-- Trigram index on the lower-cased search text.
CREATE INDEX IF NOT EXISTS "product_listings_search_text_trgm_idx" ON "product_listings" USING GIN ("search_text" gin_trgm_ops);
