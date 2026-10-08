-- CreateEnum
CREATE TYPE "DisputeEventType" AS ENUM ('DISPUTE_OPENED', 'EVIDENCE_SUBMITTED', 'ARBITRATOR_ASSIGNED', 'VOTE_CAST', 'VERDICT_REACHED');

-- CreateTable
CREATE TABLE "DisputeEvent" (
    "id" SERIAL NOT NULL,
    "disputeId" TEXT NOT NULL,
    "type" "DisputeEventType" NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DisputeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DisputeEvent_disputeId_id_idx" ON "DisputeEvent"("disputeId", "id");

-- AddForeignKey
ALTER TABLE "DisputeEvent" ADD CONSTRAINT "DisputeEvent_disputeId_fkey" FOREIGN KEY ("disputeId") REFERENCES "Dispute"("id") ON DELETE CASCADE ON UPDATE CASCADE;
