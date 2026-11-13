-- CreateTable
CREATE TABLE "saved_products" (
    "organization_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "saved_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_products_pkey" PRIMARY KEY ("organization_id","product_id")
);

-- CreateIndex
CREATE INDEX "saved_products_organization_id_created_at_idx" ON "saved_products"("organization_id", "created_at");

-- AddForeignKey
ALTER TABLE "saved_products" ADD CONSTRAINT "saved_products_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
