-- CreateEnum
CREATE TYPE "RfqStatus" AS ENUM ('draft', 'published', 'awarded', 'cancelled');

-- CreateEnum
CREATE TYPE "RfqVisibility" AS ENUM ('open', 'invited');

-- CreateEnum
CREATE TYPE "QuotationStatus" AS ENUM ('submitted', 'withdrawn', 'accepted', 'rejected');

-- CreateTable
CREATE TABLE "rfqs" (
    "id" UUID NOT NULL,
    "buyer_organization_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "currency" CHAR(3) NOT NULL,
    "delivery_terms" TEXT,
    "delivery_location" TEXT,
    "response_deadline" TIMESTAMPTZ(3) NOT NULL,
    "visibility" "RfqVisibility" NOT NULL DEFAULT 'invited',
    "status" "RfqStatus" NOT NULL DEFAULT 'draft',
    "awarded_quotation_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rfqs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rfq_lines" (
    "id" UUID NOT NULL,
    "rfq_id" UUID NOT NULL,
    "line_number" INTEGER NOT NULL,
    "product_id" UUID,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit_of_measure" TEXT NOT NULL,
    "specifications" JSONB,

    CONSTRAINT "rfq_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rfq_invitations" (
    "rfq_id" UUID NOT NULL,
    "supplier_organization_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rfq_invitations_pkey" PRIMARY KEY ("rfq_id","supplier_organization_id")
);

-- CreateTable
CREATE TABLE "quotations" (
    "id" UUID NOT NULL,
    "rfq_id" UUID NOT NULL,
    "supplier_organization_id" UUID NOT NULL,
    "status" "QuotationStatus" NOT NULL DEFAULT 'submitted',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "currency" CHAR(3) NOT NULL,
    "total" DECIMAL(18,4) NOT NULL,
    "valid_until" TIMESTAMPTZ(3) NOT NULL,
    "notes" TEXT,
    "submitted_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "quotations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotation_lines" (
    "id" UUID NOT NULL,
    "quotation_id" UUID NOT NULL,
    "rfq_line_id" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit_price" DECIMAL(18,4) NOT NULL,
    "line_total" DECIMAL(18,4) NOT NULL,
    "lead_time_days" INTEGER,

    CONSTRAINT "quotation_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotation_revisions" (
    "id" UUID NOT NULL,
    "quotation_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quotation_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rfqs_awarded_quotation_id_key" ON "rfqs"("awarded_quotation_id");

-- CreateIndex
CREATE INDEX "rfqs_buyer_organization_id_status_idx" ON "rfqs"("buyer_organization_id", "status");

-- CreateIndex
CREATE INDEX "rfqs_status_visibility_response_deadline_idx" ON "rfqs"("status", "visibility", "response_deadline");

-- CreateIndex
CREATE UNIQUE INDEX "rfq_lines_rfq_id_line_number_key" ON "rfq_lines"("rfq_id", "line_number");

-- CreateIndex
CREATE INDEX "rfq_invitations_supplier_organization_id_idx" ON "rfq_invitations"("supplier_organization_id");

-- CreateIndex
CREATE INDEX "quotations_supplier_organization_id_idx" ON "quotations"("supplier_organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "quotations_rfq_id_supplier_organization_id_key" ON "quotations"("rfq_id", "supplier_organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "quotation_lines_quotation_id_rfq_line_id_key" ON "quotation_lines"("quotation_id", "rfq_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "quotation_revisions_quotation_id_revision_key" ON "quotation_revisions"("quotation_id", "revision");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_created_at_idx" ON "outbox_events"("published_at", "created_at");

-- AddForeignKey
ALTER TABLE "rfq_lines" ADD CONSTRAINT "rfq_lines_rfq_id_fkey" FOREIGN KEY ("rfq_id") REFERENCES "rfqs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_invitations" ADD CONSTRAINT "rfq_invitations_rfq_id_fkey" FOREIGN KEY ("rfq_id") REFERENCES "rfqs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_rfq_id_fkey" FOREIGN KEY ("rfq_id") REFERENCES "rfqs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_quotation_id_fkey" FOREIGN KEY ("quotation_id") REFERENCES "quotations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_revisions" ADD CONSTRAINT "quotation_revisions_quotation_id_fkey" FOREIGN KEY ("quotation_id") REFERENCES "quotations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
