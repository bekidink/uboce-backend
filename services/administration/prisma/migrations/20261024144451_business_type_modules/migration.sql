-- CreateTable
CREATE TABLE "business_type_modules" (
    "organization_type" TEXT NOT NULL,
    "module_key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "updated_by_user_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "business_type_modules_pkey" PRIMARY KEY ("organization_type","module_key")
);
