-- PRD v2.0: invoice reminders and payment codes, cash sessions, manual receipts, bank statements.

ALTER TABLE "invoices" ADD COLUMN "payment_code" TEXT;
ALTER TABLE "invoices" ADD COLUMN "overdue_at" TIMESTAMPTZ(3);
ALTER TABLE "invoices" ADD COLUMN "reminders_sent" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "invoices" ADD COLUMN "last_reminder_at" TIMESTAMPTZ(3);
CREATE UNIQUE INDEX "invoices_payment_code_key" ON "invoices"("payment_code");
CREATE INDEX "invoices_status_due_date_idx" ON "invoices"("status", "due_date");

ALTER TABLE "payment_references" ADD COLUMN "proof_document_id" UUID;
ALTER TABLE "payment_references" ADD COLUMN "review_note" TEXT;

CREATE TYPE "CashSessionStatus" AS ENUM ('open', 'closed');
CREATE TYPE "StatementLineStatus" AS ENUM ('unmatched', 'matched', 'ignored');

CREATE TABLE "cash_sessions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "branch_id" UUID,
    "currency" CHAR(3) NOT NULL,
    "status" "CashSessionStatus" NOT NULL DEFAULT 'open',
    "opening_float" DECIMAL(18,4) NOT NULL,
    "expected_amount" DECIMAL(18,4),
    "counted_amount" DECIMAL(18,4),
    "variance" DECIMAL(18,4),
    "note" TEXT,
    "opened_by_user_id" UUID NOT NULL,
    "closed_by_user_id" UUID,
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(3),
    "deposit_line_id" UUID,
    CONSTRAINT "cash_sessions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "cash_sessions_deposit_line_id_key" ON "cash_sessions"("deposit_line_id");
CREATE INDEX "cash_sessions_organization_id_status_idx" ON "cash_sessions"("organization_id", "status");
-- One open till per person at a time.
CREATE UNIQUE INDEX "cash_sessions_one_open_per_user" ON "cash_sessions"("organization_id", "opened_by_user_id") WHERE "status" = 'open';

CREATE TABLE "cash_receipts" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "organization_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "session_id" UUID,
    "payment_reference_id" UUID NOT NULL,
    "method" TEXT NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "external_reference" TEXT,
    "note" TEXT,
    "idempotency_key" TEXT,
    "received_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cash_receipts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "cash_receipts_number_key" ON "cash_receipts"("number");
CREATE UNIQUE INDEX "cash_receipts_payment_reference_id_key" ON "cash_receipts"("payment_reference_id");
CREATE UNIQUE INDEX "cash_receipts_organization_id_idempotency_key_key" ON "cash_receipts"("organization_id", "idempotency_key");
CREATE INDEX "cash_receipts_invoice_id_idx" ON "cash_receipts"("invoice_id");
ALTER TABLE "cash_receipts" ADD CONSTRAINT "cash_receipts_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "cash_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "bank_statement_imports" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "account_label" TEXT NOT NULL,
    "file_name" TEXT,
    "line_count" INTEGER NOT NULL,
    "duplicate_count" INTEGER NOT NULL,
    "matched_count" INTEGER NOT NULL,
    "imported_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "bank_statement_imports_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "bank_statement_imports_organization_id_created_at_idx" ON "bank_statement_imports"("organization_id", "created_at");

CREATE TABLE "statement_lines" (
    "id" UUID NOT NULL,
    "import_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "booked_at" TIMESTAMPTZ(3) NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "reference" TEXT NOT NULL,
    "counterparty" TEXT,
    "description" TEXT,
    "status" "StatementLineStatus" NOT NULL DEFAULT 'unmatched',
    "match_note" TEXT,
    "invoice_id" UUID,
    "payment_reference_id" UUID,
    "matched_by_user_id" UUID,
    "matched_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "statement_lines_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "statement_lines_payment_reference_id_key" ON "statement_lines"("payment_reference_id");
CREATE UNIQUE INDEX "statement_lines_organization_id_fingerprint_key" ON "statement_lines"("organization_id", "fingerprint");
CREATE INDEX "statement_lines_organization_id_status_idx" ON "statement_lines"("organization_id", "status");
ALTER TABLE "statement_lines" ADD CONSTRAINT "statement_lines_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "bank_statement_imports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
