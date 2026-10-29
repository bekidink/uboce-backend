-- AlterTable
ALTER TABLE "promotions" ADD COLUMN     "advertised" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "description" TEXT;
