-- CreateEnum
CREATE TYPE "ProviderSubmissionStatus" AS ENUM ('ATTEMPTING', 'ACCEPTED', 'OUTCOME_UNKNOWN');

-- CreateTable
CREATE TABLE "ProviderSubmission" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "clientRequestId" TEXT NOT NULL,
    "providerTaskId" TEXT,
    "status" "ProviderSubmissionStatus" NOT NULL DEFAULT 'ATTEMPTING',
    "errorCode" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProviderSubmission_taskId_key" ON "ProviderSubmission"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderSubmission_provider_clientRequestId_key" ON "ProviderSubmission"("provider", "clientRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderSubmission_provider_providerTaskId_key" ON "ProviderSubmission"("provider", "providerTaskId");

-- CreateIndex
CREATE INDEX "ProviderSubmission_status_updatedAt_idx" ON "ProviderSubmission"("status", "updatedAt");

-- AddForeignKey
ALTER TABLE "ProviderSubmission" ADD CONSTRAINT "ProviderSubmission_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "VideoTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
