import { createHash, randomUUID } from "node:crypto";

import { TaskStatus } from "@prisma/client";

import {
  ProviderAuthenticationError,
  ProviderCreateNotSentError,
  ProviderOperationError,
  ProviderOutcomeUnknownError,
  ProviderProtocolError,
  ProviderRateLimitError,
  ProviderRequestError,
  ProviderUnsupportedOperationError,
  ProviderValidationError,
  type PublishedProviderAsset,
  type ProviderCreateAudit,
  type ProviderTaskSnapshot,
  type SeedanceProvider
} from "@seedance/seedance-provider";
import type { AssetPublisher, PublishedRemoteObject } from "@seedance/storage";
import { AssetPublishingError } from "@seedance/storage";
import type { ProviderJobScheduler } from "./job-scheduler.js";
import type { PollClaim, SubmissionTask, TaskStore } from "./task-store.js";

export interface PollingPolicy {
  baseIntervalMs: number;
  maxIntervalMs: number;
  maxDurationMs: number;
  requestTimeoutMs: number;
  jitterRatio: number;
  downloadMaxDurationMs: number;
}

interface ProcessorDependencies {
  store: TaskStore;
  provider: SeedanceProvider;
  scheduler: ProviderJobScheduler;
  policy: PollingPolicy;
  assetPublisher?: AssetPublisher;
  assetUrlMinimumTtlMs?: number;
  deletePublishedAssetsOnTerminal?: boolean;
  now?: () => Date;
  random?: () => number;
}

type PublishedAssetWithRemoteObject = PublishedProviderAsset & {
  remoteObject?: PublishedRemoteObject;
};

export function createSubmitProcessor(dependencies: ProcessorDependencies) {
  const now = dependencies.now ?? (() => new Date());
  const random = dependencies.random ?? Math.random;
  return async (taskId: string): Promise<void> => {
    const task = await dependencies.store.loadSubmissionTask(taskId);
    if (task === null || isTerminal(task.status)) return;

    let providerTaskId: string;
    let createAudit: ProviderCreateAudit | undefined;
    if (task.status === TaskStatus.QUEUED) {
      if (!(await dependencies.store.claimSubmission(task))) return;
      let publishedAssets: readonly PublishedAssetWithRemoteObject[] = [];
      const recordedRemoteObjects = new Set<string>();
      let createAttempted = false;
      try {
        publishedAssets = await publishReferenceAssets(dependencies, task);
        for (const asset of publishedAssets) {
          if (asset.remoteObject !== undefined) {
            await dependencies.store.recordPublishedAsset(
              task.id,
              asset.assetId,
              asset.remoteObject,
              asset.expiresAt
            );
            recordedRemoteObjects.add(remoteObjectIdentity(asset.remoteObject));
          }
        }
        const attempt = createSubmissionAttempt(task, publishedAssets, now());
        await dependencies.store.recordSubmissionAttempt(task, attempt);
        createAttempted = true;
        const created = await createOrRecoverProviderTask(
          dependencies,
          task,
          publishedAssets,
          attempt
        );
        providerTaskId = created.providerTaskId;
        createAudit = created.createAudit;
      } catch (error) {
        const confirmedNotCreated =
          !createAttempted || isConfirmedNotCreatedError(error);
        if (!confirmedNotCreated) {
          await dependencies.store.markSubmissionOutcomeUnknown(
            task,
            error instanceof ProviderOperationError ? error.audit : undefined
          );
          return;
        }
        await deleteUnrecordedPublishedAssets(
          dependencies,
          publishedAssets,
          recordedRemoteObjects
        );
        await dependencies.store.markSubmissionFailed(
          task,
          now(),
          submissionErrorCode(error),
          error instanceof ProviderOperationError ? error.audit : undefined
        );
        await cleanupPublishedAssets(dependencies, task.id);
        return;
      }
      if (providerTaskId.length === 0) return;
    } else if (task.status === TaskStatus.SUBMITTING) {
      providerTaskId =
        task.recoveredProviderTaskId ??
        (await dependencies.provider.recoverTask(task.clientRequestId)) ??
        "";
      if (providerTaskId.length === 0) {
        await dependencies.store.markSubmissionOutcomeUnknown(task);
        return;
      }
    } else {
      return;
    }

    const acceptedAt = now();
    const firstPollAt = addMilliseconds(
      acceptedAt,
      jitteredDelay(
        dependencies.policy.baseIntervalMs,
        dependencies.policy.jitterRatio,
        random
      )
    );
    const accepted = await dependencies.store.acceptSubmission(
      task,
      providerTaskId,
      {
        now: acceptedAt,
        nextPollAt: firstPollAt,
        pollDeadlineAt: addMilliseconds(
          acceptedAt,
          dependencies.policy.maxDurationMs
        ),
        pollVersion: 1,
        ...(createAudit === undefined ? {} : { createAudit })
      }
    );
    if (!accepted) return;
    await dependencies.scheduler
      .schedulePoll(task.id, 1, firstPollAt)
      .catch(() => undefined);
  };
}

function remoteObjectIdentity(remoteObject: PublishedRemoteObject): string {
  return `${remoteObject.publisher}\u0000${remoteObject.bucket}\u0000${remoteObject.objectKey}`;
}

export function createPollProcessor(dependencies: ProcessorDependencies) {
  const now = dependencies.now ?? (() => new Date());
  const random = dependencies.random ?? Math.random;
  return async (taskId: string, pollVersion: number): Promise<void> => {
    const startedAt = now();
    const claim = await dependencies.store.claimPoll(
      taskId,
      pollVersion,
      startedAt,
      addMilliseconds(startedAt, dependencies.policy.requestTimeoutMs + 1_000)
    );
    if (claim === null) return;
    if (startedAt >= claim.pollDeadlineAt) {
      await dependencies.store.expireLocalPoll(claim, startedAt);
      return;
    }

    try {
      const snapshot = await dependencies.provider.getTask(
        claim.providerTaskId
      );
      await handleSnapshot(dependencies, claim, snapshot, now(), random);
    } catch (error) {
      await handlePollError(dependencies, claim, error, now(), random);
    }
  };
}

async function createOrRecoverProviderTask(
  dependencies: ProcessorDependencies,
  task: SubmissionTask,
  publishedAssets: readonly PublishedProviderAsset[],
  attempt: {
    createAttemptId: string;
    requestPayloadSha256: string;
  }
): Promise<{
  providerTaskId: string;
  createAudit?: ProviderCreateAudit;
}> {
  try {
    const snapshot = await dependencies.provider.createTask({
      clientRequestId: task.clientRequestId,
      createAttemptId: attempt.createAttemptId,
      requestPayloadSha256: attempt.requestPayloadSha256,
      model: task.model,
      prompt: task.prompt,
      referenceAssetIds: task.referenceAssetIds,
      publishedAssets,
      parameters: task.parameters
    });
    return {
      providerTaskId: snapshot.providerTaskId,
      ...(snapshot.createAudit === undefined
        ? {}
        : { createAudit: snapshot.createAudit })
    };
  } catch (error) {
    if (isConfirmedNotCreatedError(error)) throw error;
    const unknown =
      error instanceof ProviderOutcomeUnknownError
        ? error
        : new ProviderOutcomeUnknownError(error);
    const recoveredId = await dependencies.provider
      .recoverTask(task.clientRequestId)
      .catch(() => null);
    if (recoveredId !== null) {
      return {
        providerTaskId: recoveredId,
        ...(unknown.audit === undefined ? {} : { createAudit: unknown.audit })
      };
    }
    await dependencies.store.markSubmissionOutcomeUnknown(task, unknown.audit);
    return { providerTaskId: "" };
  }
}

async function deleteUnrecordedPublishedAssets(
  dependencies: ProcessorDependencies,
  publishedAssets: readonly PublishedAssetWithRemoteObject[],
  recordedRemoteObjects: ReadonlySet<string>
): Promise<void> {
  await Promise.all(
    publishedAssets.flatMap((asset) =>
      asset.remoteObject === undefined ||
      recordedRemoteObjects.has(remoteObjectIdentity(asset.remoteObject)) ||
      dependencies.assetPublisher?.deletePublishedAsset === undefined
        ? []
        : [
            dependencies.assetPublisher
              .deletePublishedAsset(asset.remoteObject)
              .catch(() => undefined)
          ]
    )
  );
}

function createSubmissionAttempt(
  task: SubmissionTask,
  publishedAssets: readonly PublishedProviderAsset[],
  requestStartedAt: Date
) {
  const summary = {
    clientRequestId: task.clientRequestId,
    model: task.model,
    prompt: task.prompt,
    parameters: task.parameters,
    assets: publishedAssets.map((asset) => ({
      assetId: asset.assetId,
      role: asset.role,
      position: asset.position,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      checksum: asset.checksum
    }))
  };
  return {
    createAttemptId: randomUUID(),
    requestPayloadSha256: createHash("sha256")
      .update(JSON.stringify(summary))
      .digest("hex"),
    requestStartedAt
  };
}

async function publishReferenceAssets(
  dependencies: ProcessorDependencies,
  task: SubmissionTask
): Promise<readonly PublishedAssetWithRemoteObject[]> {
  if (dependencies.provider.name !== "seedance") return [];
  if (task.referenceAssetIds.length === 0) return [];
  if (task.referenceAssetIds.length > 1) {
    throw new ProviderProtocolError(
      "CREATE",
      "Seedance MVP accepts at most one reference asset."
    );
  }
  if (dependencies.assetPublisher === undefined) {
    throw new ProviderProtocolError(
      "CREATE",
      "Reference asset publishing is not configured."
    );
  }
  const minimumTtlMs =
    dependencies.assetUrlMinimumTtlMs ??
    dependencies.policy.requestTimeoutMs + 60_000;
  const assetId = task.referenceAssetIds[0]!;
  const role = task.referenceAssetRoles?.[0] ?? "REFERENCE_IMAGE";
  const asset = await dependencies.assetPublisher.publishForProvider({
    assetId,
    provider: "seedance",
    purpose: role === "REFERENCE_VIDEO" ? "reference-video" : "reference-image",
    minimumTtlMs
  });
  return [{ ...asset, position: 0 }];
}

async function handleSnapshot(
  dependencies: ProcessorDependencies,
  claim: PollClaim,
  snapshot: ProviderTaskSnapshot,
  currentTime: Date,
  random: () => number
): Promise<void> {
  const providerStatus = safeProviderStatus(snapshot);
  switch (snapshot.status) {
    case "PROCESSING": {
      const nextPollAt = addMilliseconds(
        currentTime,
        jitteredDelay(
          dependencies.policy.baseIntervalMs,
          dependencies.policy.jitterRatio,
          random
        )
      );
      const updated = await dependencies.store.scheduleNextPoll(claim, {
        now: currentTime,
        nextPollAt,
        providerStatus,
        transientErrors: 0
      });
      if (updated) {
        await dependencies.scheduler
          .schedulePoll(claim.taskId, claim.pollVersion + 1, nextPollAt)
          .catch(() => undefined);
      }
      return;
    }
    case "SUCCEEDED": {
      if (
        !snapshot.outputs.some(
          (output) => output.kind === "video" && output.available
        )
      ) {
        throw new ProviderProtocolError(
          "GET",
          "Succeeded Provider task has no available video output."
        );
      }
      const schedule = await dependencies.store.markDownloadPending(
        claim,
        currentTime,
        addMilliseconds(currentTime, dependencies.policy.downloadMaxDurationMs),
        dependencies.provider.name,
        snapshot.usage,
        providerStatus
      );
      if (schedule !== null) {
        await dependencies.scheduler
          .scheduleDownload(
            schedule.taskId,
            schedule.providerTaskId,
            schedule.downloadVersion,
            schedule.nextDownloadAt
          )
          .catch(() => undefined);
      }
      return;
    }
    case "FAILED": {
      const failed = await dependencies.store.markProviderFailed(
        claim,
        currentTime,
        snapshot.error?.code ?? "PROVIDER_TASK_FAILED",
        snapshot.error?.message ?? "Provider task failed.",
        providerStatus
      );
      if (failed) await cleanupPublishedAssets(dependencies, claim.taskId);
      return;
    }
    case "CANCELLED": {
      const stopped = await dependencies.store.markProviderStopped(
        claim,
        currentTime,
        TaskStatus.CANCELLED,
        providerStatus
      );
      if (stopped) await cleanupPublishedAssets(dependencies, claim.taskId);
      return;
    }
    case "EXPIRED": {
      const stopped = await dependencies.store.markProviderStopped(
        claim,
        currentTime,
        TaskStatus.EXPIRED,
        providerStatus
      );
      if (stopped) await cleanupPublishedAssets(dependencies, claim.taskId);
      return;
    }
  }
}

async function handlePollError(
  dependencies: ProcessorDependencies,
  claim: PollClaim,
  error: unknown,
  currentTime: Date,
  random: () => number
): Promise<void> {
  if (error instanceof ProviderOperationError && error.retryable) {
    const transientErrors = claim.transientErrors + 1;
    const exponentialDelay = Math.min(
      dependencies.policy.maxIntervalMs,
      dependencies.policy.baseIntervalMs * 2 ** Math.min(transientErrors, 30)
    );
    const delay = Math.max(
      jitteredDelay(exponentialDelay, dependencies.policy.jitterRatio, random),
      error.retryAfterMs ?? 0
    );
    const nextPollAt = addMilliseconds(currentTime, delay);
    if (nextPollAt >= claim.pollDeadlineAt) {
      await dependencies.store.expireLocalPoll(claim, currentTime);
      return;
    }
    const updated = await dependencies.store.scheduleNextPoll(claim, {
      now: currentTime,
      nextPollAt,
      transientErrors,
      lastPollError: error.code
    });
    if (updated) {
      await dependencies.scheduler
        .schedulePoll(claim.taskId, claim.pollVersion + 1, nextPollAt)
        .catch(() => undefined);
    }
    return;
  }

  await dependencies.store.stopPollingForManualReview(
    claim,
    currentTime,
    error instanceof ProviderOperationError
      ? error.code
      : "PROVIDER_POLL_UNCLASSIFIED_ERROR"
  );
}

export type PublishedAssetCleanupStore = Pick<
  TaskStore,
  | "findPublishedAssets"
  | "markPublishedAssetDeleted"
  | "markPublishedAssetCleanupFailed"
>;

export async function cleanupTerminalPublishedAssets(
  dependencies: {
    store: TaskStore;
    assetPublisher?: AssetPublisher;
    deletePublishedAssetsOnTerminal?: boolean;
  },
  limit: number
): Promise<void> {
  if (dependencies.deletePublishedAssetsOnTerminal === false) return;
  const taskIds =
    await dependencies.store.findTerminalTasksWithPublishedAssets(limit);
  for (const taskId of taskIds) {
    await cleanupPublishedAssets(dependencies, taskId);
  }
}

export async function cleanupPublishedAssets(
  dependencies: {
    store: PublishedAssetCleanupStore;
    assetPublisher?: AssetPublisher;
    deletePublishedAssetsOnTerminal?: boolean;
  },
  taskId: string
): Promise<void> {
  if (
    dependencies.deletePublishedAssetsOnTerminal === false ||
    dependencies.assetPublisher?.deletePublishedAsset === undefined
  ) {
    return;
  }
  const remoteObjects = await dependencies.store.findPublishedAssets(taskId);
  await Promise.all(
    remoteObjects.map(async (remoteObject) => {
      try {
        await dependencies.assetPublisher!.deletePublishedAsset!(remoteObject);
        await dependencies.store.markPublishedAssetDeleted(
          remoteObject,
          new Date()
        );
      } catch {
        await dependencies.store
          .markPublishedAssetCleanupFailed(remoteObject, "OBJECT_DELETE_FAILED")
          .catch(() => undefined);
      }
    })
  );
}

function submissionErrorCode(error: unknown): string {
  return error instanceof AssetPublishingError
    ? error.code
    : error instanceof ProviderOperationError
      ? error.code
      : "PROVIDER_CREATE_FAILED";
}

function isConfirmedNotCreatedError(error: unknown): boolean {
  return (
    error instanceof ProviderAuthenticationError ||
    error instanceof ProviderCreateNotSentError ||
    error instanceof ProviderRateLimitError ||
    error instanceof ProviderRequestError ||
    error instanceof ProviderUnsupportedOperationError ||
    error instanceof ProviderValidationError
  );
}

function safeProviderStatus(snapshot: ProviderTaskSnapshot): string {
  return (snapshot.debug?.providerStatus ?? snapshot.status).slice(0, 128);
}

function jitteredDelay(
  delayMs: number,
  jitterRatio: number,
  random: () => number
): number {
  const boundedRandom = Math.min(1, Math.max(0, random()));
  const factor = 1 + (boundedRandom * 2 - 1) * jitterRatio;
  return Math.max(1, Math.round(delayMs * factor));
}

function addMilliseconds(value: Date, milliseconds: number): Date {
  return new Date(value.getTime() + milliseconds);
}

function isTerminal(status: TaskStatus): boolean {
  return (
    status === TaskStatus.SUCCEEDED ||
    status === TaskStatus.RECONCILIATION_REQUIRED ||
    status === TaskStatus.FAILED ||
    status === TaskStatus.CANCELLED ||
    status === TaskStatus.EXPIRED
  );
}
