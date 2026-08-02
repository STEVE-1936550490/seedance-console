ALTER TABLE "VideoTask"
  ADD COLUMN "providerAssetCleanupReadyAt" TIMESTAMPTZ(3);

ALTER TABLE "ProviderSubmission"
  ALTER COLUMN "requestStartedAt" TYPE TIMESTAMPTZ(3)
    USING "requestStartedAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "requestEndedAt" TYPE TIMESTAMPTZ(3)
    USING "requestEndedAt" AT TIME ZONE 'UTC';
