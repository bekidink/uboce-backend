-- AlterTable
ALTER TABLE "memberships" ADD COLUMN     "role_template_id" UUID;

-- CreateTable
CREATE TABLE "role_templates" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "permissions" TEXT[],
    "approval_limit" DECIMAL(18,4),
    "approval_currency" CHAR(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "role_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "role_templates_organization_id_name_key" ON "role_templates"("organization_id", "name");

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_role_template_id_fkey" FOREIGN KEY ("role_template_id") REFERENCES "role_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
