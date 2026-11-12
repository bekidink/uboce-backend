-- AlterEnum
ALTER TYPE "OrganizationType" ADD VALUE 'individual';

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "personal_user_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "organizations_personal_user_id_key" ON "organizations"("personal_user_id");
