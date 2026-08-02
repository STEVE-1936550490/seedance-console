ALTER TYPE "TaskStatus" ADD VALUE IF NOT EXISTS 'RECONCILIATION_REQUIRED';
ALTER TYPE "ProviderSubmissionStatus" ADD VALUE IF NOT EXISTS 'NOT_CREATED';

ALTER TABLE "ProviderSubmission"
  ADD COLUMN "createAttemptId" TEXT,
  ADD COLUMN "requestPayloadSha256" TEXT,
  ADD COLUMN "bridgeRequestId" TEXT,
  ADD COLUMN "requestStartedAt" TIMESTAMP(3),
  ADD COLUMN "requestEndedAt" TIMESTAMP(3),
  ADD COLUMN "failureStage" TEXT,
  ADD COLUMN "exceptionType" TEXT,
  ADD COLUMN "requestBodySent" BOOLEAN,
  ADD COLUMN "providerHttpStatus" INTEGER,
  ADD COLUMN "providerErrorCode" TEXT,
  ADD COLUMN "providerRequestId" TEXT,
  ADD COLUMN "providerTraceId" TEXT,
  ADD COLUMN "reconciliationNote" TEXT,
  ADD COLUMN "reconciledAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "ProviderSubmission_createAttemptId_key"
ON "ProviderSubmission"("createAttemptId");
