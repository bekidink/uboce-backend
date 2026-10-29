-- AlterTable
ALTER TABLE "product_listings" ADD COLUMN     "category_path" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE INDEX "product_listings_category_path_idx" ON "product_listings" USING GIN ("category_path");
