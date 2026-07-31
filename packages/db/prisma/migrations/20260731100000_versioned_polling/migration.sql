-- AlterTable
ALTER TABLE "VideoTask"
ADD COLUMN "pollStartedAt" TIMESTAMP(3),
ADD COLUMN "nextPollAt" TIMESTAMP(3),
ADD COLUMN "lastPolledAt" TIMESTAMP(3),
ADD COLUMN "pollDeadlineAt" TIMESTAMP(3),
ADD COLUMN "pollLeaseUntil" TIMESTAMP(3),
ADD COLUMN "pollVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "pollAttempt" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "pollTransientErrors" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lastProviderStatus" TEXT,
ADD COLUMN "lastPollError" TEXT,
ADD COLUMN "downloadPending" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "VideoTask_status_nextPollAt_idx" ON "VideoTask"("status", "nextPollAt");

-- CreateIndex
CREATE INDEX "VideoTask_status_downloadPending_idx" ON "VideoTask"("status", "downloadPending");
