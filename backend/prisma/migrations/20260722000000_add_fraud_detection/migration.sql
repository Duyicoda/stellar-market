-- CreateEnum
CREATE TYPE "RiskSubjectType" AS ENUM ('USER', 'JOB', 'TRANSACTION');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "RiskTrigger" AS ENUM ('JOB_CREATED', 'ESCROW_RELEASE', 'MANUAL', 'BATCH');

-- CreateEnum
CREATE TYPE "RiskFlagStatus" AS ENUM ('OPEN', 'UNDER_REVIEW', 'CONFIRMED', 'FALSE_POSITIVE', 'DISMISSED');

-- CreateTable
CREATE TABLE "RiskFlag" (
    "id" TEXT NOT NULL,
    "subjectType" "RiskSubjectType" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "currentScore" DOUBLE PRECISION NOT NULL,
    "currentLevel" "RiskLevel" NOT NULL,
    "status" "RiskFlagStatus" NOT NULL DEFAULT 'OPEN',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RiskFlag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskAssessment" (
    "id" TEXT NOT NULL,
    "subjectType" "RiskSubjectType" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "level" "RiskLevel" NOT NULL,
    "signals" JSONB NOT NULL,
    "trigger" "RiskTrigger" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "flagId" TEXT,

    CONSTRAINT "RiskAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RiskFlag_subjectType_subjectId_key" ON "RiskFlag"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "RiskFlag_status_idx" ON "RiskFlag"("status");

-- CreateIndex
CREATE INDEX "RiskFlag_currentLevel_idx" ON "RiskFlag"("currentLevel");

-- CreateIndex
CREATE INDEX "RiskFlag_updatedAt_idx" ON "RiskFlag"("updatedAt");

-- CreateIndex
CREATE INDEX "RiskAssessment_subjectType_subjectId_createdAt_idx" ON "RiskAssessment"("subjectType", "subjectId", "createdAt");

-- CreateIndex
CREATE INDEX "RiskAssessment_level_idx" ON "RiskAssessment"("level");

-- CreateIndex
CREATE INDEX "RiskAssessment_createdAt_idx" ON "RiskAssessment"("createdAt");

-- AddForeignKey
ALTER TABLE "RiskAssessment" ADD CONSTRAINT "RiskAssessment_flagId_fkey" FOREIGN KEY ("flagId") REFERENCES "RiskFlag"("id") ON DELETE SET NULL ON UPDATE CASCADE;
