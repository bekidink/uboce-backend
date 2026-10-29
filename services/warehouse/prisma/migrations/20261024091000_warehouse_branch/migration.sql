-- AlterTable
ALTER TABLE "warehouses" ADD COLUMN     "branch_id" UUID;

-- CreateIndex
CREATE INDEX "warehouses_organization_id_branch_id_idx" ON "warehouses"("organization_id", "branch_id");

