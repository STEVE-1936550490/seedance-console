-- AlterTable
ALTER TABLE "VideoTask"
ADD COLUMN "downloadStartedAt" TIMESTAMP(3),
ADD COLUMN "nextDownloadAt" TIMESTAMP(3),
ADD COLUMN "lastDownloadAt" TIMESTAMP(3),
ADD COLUMN "downloadDeadlineAt" TIMESTAMP(3),
ADD COLUMN "downloadLeaseUntil" TIMESTAMP(3),
ADD COLUMN "downloadVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "downloadAttempt" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "downloadErrors" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lastDownloadError" TEXT;

-- Existing output-ready tasks predate versioned download scheduling. Give
-- only those records a recoverable first version; unrelated historical tasks
-- retain version 0 and NULL scheduling fields.
UPDATE "VideoTask"
SET
  "downloadStartedAt" = COALESCE("lastPolledAt", "updatedAt"),
  "nextDownloadAt" = CURRENT_TIMESTAMP,
  "downloadDeadlineAt" = CURRENT_TIMESTAMP + INTERVAL '1 day',
  "downloadVersion" = 1
WHERE
  "status" = 'PROCESSING'
  AND "downloadPending" = true
  AND "providerTaskId" IS NOT NULL;

-- CreateTable
CREATE TABLE "VideoOutput" (
  "id" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "assetId" TEXT NOT NULL,
  "providerTaskId" TEXT NOT NULL,
  "storageKey" TEXT NOT NULL,
  "sha256" TEXT NOT NULL,
  "fileSize" BIGINT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "VideoOutput_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VideoOutput_taskId_key" ON "VideoOutput"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "VideoOutput_assetId_key" ON "VideoOutput"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "VideoOutput_storageKey_key" ON "VideoOutput"("storageKey");

-- CreateIndex
CREATE INDEX "VideoOutput_providerTaskId_idx" ON "VideoOutput"("providerTaskId");

-- CreateIndex
CREATE INDEX "VideoTask_status_nextDownloadAt_idx" ON "VideoTask"("status", "nextDownloadAt");

-- AddForeignKey
ALTER TABLE "VideoOutput"
ADD CONSTRAINT "VideoOutput_taskId_fkey"
FOREIGN KEY ("taskId") REFERENCES "VideoTask"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoOutput"
ADD CONSTRAINT "VideoOutput_assetId_fkey"
FOREIGN KEY ("assetId") REFERENCES "Asset"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
