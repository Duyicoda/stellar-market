-- CreateEnum
CREATE TYPE "EscrowEventType" AS ENUM ('JOB_CREATED', 'JOB_FUNDED', 'PAYMENT_RELEASED', 'DISPUTE_OPENED', 'DISPUTE_RESOLVED', 'REFUNDED', 'EXPIRED');

-- CreateTable
CREATE TABLE "EscrowEvent" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "contractJobId" TEXT NOT NULL,
    "eventType" "EscrowEventType" NOT NULL,
    "ledgerSeq" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EscrowEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EscrowEvent_contractJobId_eventType_ledgerSeq_key" ON "EscrowEvent"("contractJobId", "eventType", "ledgerSeq");

-- CreateIndex
CREATE INDEX "EscrowEvent_jobId_ledgerSeq_idx" ON "EscrowEvent"("jobId", "ledgerSeq");

-- AddForeignKey
ALTER TABLE "EscrowEvent" ADD CONSTRAINT "EscrowEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
