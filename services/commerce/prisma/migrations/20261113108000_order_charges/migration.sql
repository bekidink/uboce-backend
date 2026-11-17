-- PRD v2.0 ORD-06, CAT-11: delivery fee, tax and party names stored with each order.
ALTER TABLE "orders" ADD COLUMN "delivery_fee" DECIMAL(18,4) NOT NULL DEFAULT 0;
ALTER TABLE "orders" ADD COLUMN "delivery_tax" DECIMAL(18,4) NOT NULL DEFAULT 0;
ALTER TABLE "orders" ADD COLUMN "delivery_tax_rate_pct" DECIMAL(5,2);
ALTER TABLE "orders" ADD COLUMN "delivery_quote" JSONB;
ALTER TABLE "orders" ADD COLUMN "delivery_city" TEXT;
ALTER TABLE "orders" ADD COLUMN "delivery_region" TEXT;
ALTER TABLE "orders" ADD COLUMN "tax_total" DECIMAL(18,4) NOT NULL DEFAULT 0;
ALTER TABLE "orders" ADD COLUMN "tax_inclusive" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "orders" ADD COLUMN "tax_calculated" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "orders" ADD COLUMN "tax_breakdown" JSONB;
ALTER TABLE "orders" ADD COLUMN "buyer_legal_name" TEXT;
ALTER TABLE "orders" ADD COLUMN "seller_legal_name" TEXT;

ALTER TABLE "order_lines" ADD COLUMN "discount_amount" DECIMAL(18,4) NOT NULL DEFAULT 0;
ALTER TABLE "order_lines" ADD COLUMN "net_amount" DECIMAL(18,4);
ALTER TABLE "order_lines" ADD COLUMN "tax_amount" DECIMAL(18,4) NOT NULL DEFAULT 0;
ALTER TABLE "order_lines" ADD COLUMN "tax_rate_pct" DECIMAL(5,2);
ALTER TABLE "order_lines" ADD COLUMN "tax_code" TEXT;
