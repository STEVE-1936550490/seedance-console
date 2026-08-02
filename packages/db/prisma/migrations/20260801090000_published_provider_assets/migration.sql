-- Persist only remote object coordinates. Presigned URLs and credentials are
-- intentionally never stored.
CREATE TABLE "PublishedProviderAsset" (
  "id" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "assetId" TEXT NOT NULL,
  "publisher" TEXT NOT NULL,
  "bucket" TEXT NOT NULL,
  "objectKey" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP(3),
  "cleanupError" TEXT,
  CONSTRAINT "PublishedProviderAsset_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PublishedProviderAsset_publisher_bucket_objectKey_key"
ON "PublishedProviderAsset"("publisher", "bucket", "objectKey");

CREATE INDEX "PublishedProviderAsset_taskId_deletedAt_idx"
ON "PublishedProviderAsset"("taskId", "deletedAt");

ALTER TABLE "PublishedProviderAsset"
ADD CONSTRAINT "PublishedProviderAsset_taskId_fkey"
FOREIGN KEY ("taskId") REFERENCES "VideoTask"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PublishedProviderAsset"
ADD CONSTRAINT "PublishedProviderAsset_assetId_fkey"
FOREIGN KEY ("assetId") REFERENCES "Asset"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
