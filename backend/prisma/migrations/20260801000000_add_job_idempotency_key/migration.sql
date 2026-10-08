-- Add a unique, client-supplied idempotency key to Job so that atomic
-- job+milestone creation can be safely retried after a partial failure without
-- creating a duplicate job (issue #1125). NULL keys are allowed and are not
-- subject to the unique constraint (Postgres treats NULLs as distinct).

-- AlterTable
ALTER TABLE "Job" ADD COLUMN "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Job_idempotencyKey_key" ON "Job"("idempotencyKey");
