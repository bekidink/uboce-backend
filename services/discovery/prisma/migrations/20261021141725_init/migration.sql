-- CreateTable
CREATE TABLE "product_listings" (
    "product_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category_id" UUID NOT NULL,
    "category_slug" TEXT NOT NULL,
    "unit_of_measure" TEXT NOT NULL,
    "attributes" JSONB NOT NULL,
    "variants" JSONB NOT NULL,
    "min_price" DECIMAL(18,4) NOT NULL,
    "max_price" DECIMAL(18,4) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "published_at" TIMESTAMPTZ(3) NOT NULL,
    "source_occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "indexed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "search_document" tsvector,

    CONSTRAINT "product_listings_pkey" PRIMARY KEY ("product_id")
);

-- CreateTable
CREATE TABLE "organization_profiles" (
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "status" TEXT NOT NULL,
    "verification_status" TEXT NOT NULL,
    "source_occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "indexed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_profiles_pkey" PRIMARY KEY ("organization_id")
);

-- CreateTable
CREATE TABLE "index_state" (
    "id" TEXT NOT NULL,
    "last_event_id" UUID NOT NULL,
    "last_event_occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "last_indexed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "index_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_events" (
    "event_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex
CREATE INDEX "product_listings_search_document_idx" ON "product_listings" USING GIN ("search_document");

-- CreateIndex
CREATE INDEX "product_listings_category_slug_idx" ON "product_listings"("category_slug");

-- CreateIndex
CREATE INDEX "product_listings_organization_id_idx" ON "product_listings"("organization_id");

-- CreateIndex
CREATE INDEX "product_listings_min_price_idx" ON "product_listings"("min_price");
