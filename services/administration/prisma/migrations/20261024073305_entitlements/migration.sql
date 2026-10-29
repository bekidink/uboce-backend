-- CreateTable
CREATE TABLE "entitlements" (
    "organization_id" UUID NOT NULL,
    "module_key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "valid_until" TIMESTAMPTZ(3),
    "note" TEXT,
    "updated_by_user_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "entitlements_pkey" PRIMARY KEY ("organization_id","module_key")
);
