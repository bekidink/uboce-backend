-- PRD v2.0 FIN-09, LOG-06: tax class per product, shipping weight per variant.
ALTER TABLE "products" ADD COLUMN "tax_class" TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE "product_variants" ADD COLUMN "weight_kg" DECIMAL(12,3);
