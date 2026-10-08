-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'EXPIRED');

-- AlterTable — make previously required fields nullable to support pre-registration
ALTER TABLE "Transaction"
  ALTER COLUMN "jobId"        DROP NOT NULL,
  ALTER COLUMN "fromAddress"  DROP NOT NULL,
  ALTER COLUMN "toAddress"    DROP NOT NULL,
  ALTER COLUMN "amount"       DROP NOT NULL,
  ALTER COLUMN "tokenAddress" DROP NOT NULL;

-- AddColumn — idempotency / status fields
ALTER TABLE "Transaction"
  ADD COLUMN "status"          "TransactionStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "maxLedger"       INTEGER,
  ADD COLUMN "confirmedLedger" INTEGER,
  ADD COLUMN "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill: mark all pre-existing rows as SUCCESS (they were created after confirmed submission)
UPDATE "Transaction" SET "status" = 'SUCCESS', "updatedAt" = "createdAt" WHERE true;

-- CreateIndex
CREATE INDEX "Transaction_status_idx" ON "Transaction"("status");
