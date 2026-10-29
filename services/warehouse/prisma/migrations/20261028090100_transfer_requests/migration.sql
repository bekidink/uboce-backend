-- CreateTable
CREATE TABLE "transfer_requests" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "from_warehouse_id" UUID NOT NULL,
    "to_warehouse_id" UUID NOT NULL,
    "from_branch_id" UUID,
    "to_branch_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "note" TEXT,
    "response_note" TEXT,
    "needed_by" DATE,
    "requested_by_user_id" UUID NOT NULL,
    "responded_by_user_id" UUID,
    "dispatched_by_user_id" UUID,
    "received_by_user_id" UUID,
    "responded_at" TIMESTAMPTZ(3),
    "dispatched_at" TIMESTAMPTZ(3),
    "received_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "transfer_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfer_request_lines" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "requested_quantity" DECIMAL(18,4) NOT NULL,
    "approved_quantity" DECIMAL(18,4),
    "received_quantity" DECIMAL(18,4),

    CONSTRAINT "transfer_request_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "transfer_requests_organization_id_status_idx" ON "transfer_requests"("organization_id", "status");

-- CreateIndex
CREATE INDEX "transfer_requests_from_warehouse_id_idx" ON "transfer_requests"("from_warehouse_id");

-- CreateIndex
CREATE INDEX "transfer_requests_to_warehouse_id_idx" ON "transfer_requests"("to_warehouse_id");

-- CreateIndex
CREATE UNIQUE INDEX "transfer_requests_organization_id_number_key" ON "transfer_requests"("organization_id", "number");

-- CreateIndex
CREATE INDEX "transfer_request_lines_request_id_idx" ON "transfer_request_lines"("request_id");

-- AddForeignKey
ALTER TABLE "transfer_request_lines" ADD CONSTRAINT "transfer_request_lines_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "transfer_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
