import {
  AssetKind,
  AssetRole,
  Prisma,
  TaskStatus,
  type PrismaClient
} from "@prisma/client";

import {
  ProviderOperationError,
  ProviderOutcomeUnknownError,
  ProviderProtocolError,
  type ProviderTaskSnapshot,
  type SeedanceProvider
} from "@seedance/seedance-provider";
import type { Storage } from "@seedance/storage";

import type { ProviderJobScheduler } from "./job-scheduler.js";
import type { PollClaim, SubmissionTask, TaskStore } from "./task-store.js";

export interface PollingPolicy {
  baseIntervalMs: number;
  maxIntervalMs: number;
  maxDurationMs: number;
  requestTimeoutMs: number;
  jitterRatio: number;
}

interface ProcessorDependencies {
  store: TaskStore;
  provider: SeedanceProvider;
  scheduler: ProviderJobScheduler;
  policy: PollingPolicy;
  now?: () => Date;
  random?: () => number;
}

export function createSubmitProcessor(dependencies: ProcessorDependencies) {
  const now = dependencies.now ?? (() => new Date());
  const random = dependencies.random ?? Math.random;
  return async (taskId: string): Promise<void> => {
    const task = await dependencies.store.loadSubmissionTask(taskId);
    if (task === null || isTerminal(task.status)) return;

    let providerTaskId: string;
    if (task.status === TaskStatus.QUEUED) {
      if (!(await dependencies.store.claimSubmission(task))) return;
      providerTaskId = await createOrRecoverProviderTask(dependencies, task);
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
        pollVersion: 1
      }
    );
    if (!accepted) return;
    await dependencies.scheduler
      .schedulePoll(task.id, 1, firstPollAt)
      .catch(() => undefined);
  };
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

export interface DownloadProcessorDependencies {
  prisma: PrismaClient;
  provider: SeedanceProvider;
  storage: Storage;
  now?: () => Date;
}

/**
 * Mock-compatible download boundary. Real Provider hardening (atomic temporary
 * files, size/MIME/signature checks, and recovery) remains stage 6 work.
 */
export function createDownloadProcessor(
  dependencies: DownloadProcessorDependencies
) {
  const now = dependencies.now ?? (() => new Date());
  return async (taskId: string): Promise<void> => {
    const task = await dependencies.prisma.videoTask.findUnique({
      where: { id: taskId }
    });
    if (
      task === null ||
      task.status !== TaskStatus.PROCESSING ||
      !task.downloadPending ||
      task.providerTaskId === null
    ) {
      return;
    }

    const snapshot = await dependencies.provider.getTask(task.providerTaskId);
    if (snapshot.status !== "SUCCEEDED") {
      throw new ProviderProtocolError(
        "DOWNLOAD",
        "Provider output is no longer ready."
      );
    }
    const existingOutput = await dependencies.prisma.taskAsset.findFirst({
      where: { taskId, role: AssetRole.GENERATED_VIDEO }
    });
    if (existingOutput !== null) return;

    const storageKey = `outputs/${taskId}.mp4`;
    const stored = await dependencies.storage
      .stat(storageKey)
      .catch(async () => {
        const output = await dependencies.provider.downloadOutput(
          task.providerTaskId as string,
          { kind: "video" }
        );
        return dependencies.storage.put(storageKey, output.body);
      });

    await dependencies.prisma.$transaction(async (transaction) => {
      const asset = await transaction.asset.create({
        data: {
          kind: AssetKind.OUTPUT_VIDEO,
          storageKey,
          originalName: `${taskId}.mp4`,
          mimeType: "video/mp4",
          sizeBytes: stored.sizeBytes
        }
      });
      await transaction.taskAsset.create({
        data: {
          taskId,
          assetId: asset.id,
          role: AssetRole.GENERATED_VIDEO
        }
      });
      if (snapshot.usage.length > 0) {
        await transaction.usageRecord.createMany({
          data: snapshot.usage.map((usage) => ({
            taskId,
            provider: dependencies.provider.name,
            metric: usage.metric,
            quantity: new Prisma.Decimal(usage.quantity),
            unit: usage.unit,
            raw: {
              source: dependencies.provider.name,
              testOnly: dependencies.provider.name === "mock"
            }
          }))
        });
      }
      const completed = await transaction.videoTask.updateMany({
        where: {
          id: taskId,
          status: TaskStatus.PROCESSING,
          downloadPending: true,
          providerTaskId: task.providerTaskId
        },
        data: {
          status: TaskStatus.SUCCEEDED,
          downloadPending: false,
          completedAt: now()
        }
      });
      if (completed.count !== 1) {
        throw new TaskNoLongerDownloadableError();
      }
      await transaction.taskEvent.create({
        data: {
          taskId,
          fromStatus: TaskStatus.PROCESSING,
          toStatus: TaskStatus.SUCCEEDED,
          reason: "OUTPUT_STORED"
        }
      });
    });
  };
}

async function createOrRecoverProviderTask(
  dependencies: ProcessorDependencies,
  task: SubmissionTask
): Promise<string> {
  try {
    const snapshot = await dependencies.provider.createTask({
      clientRequestId: task.clientRequestId,
      model: task.model,
      prompt: task.prompt,
      referenceAssetIds: task.referenceAssetIds,
      parameters: task.parameters
    });
    return snapshot.providerTaskId;
  } catch (error) {
    if (!(error instanceof ProviderOutcomeUnknownError)) throw error;
    const recoveredId = await dependencies.provider.recoverTask(
      task.clientRequestId
    );
    if (recoveredId !== null) return recoveredId;
    await dependencies.store.markSubmissionOutcomeUnknown(task);
    return "";
  }
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
      const updated = await dependencies.store.markDownloadPending(
        claim,
        currentTime,
        providerStatus
      );
      if (updated) {
        await dependencies.scheduler
          .scheduleDownload(claim.taskId)
          .catch(() => undefined);
      }
      return;
    }
    case "FAILED":
      await dependencies.store.markProviderFailed(
        claim,
        currentTime,
        snapshot.error?.code ?? "PROVIDER_TASK_FAILED",
        snapshot.error?.message ?? "Provider task failed.",
        providerStatus
      );
      return;
    case "CANCELLED":
      await dependencies.store.stopPollingForManualReview(
        claim,
        currentTime,
        "PROVIDER_REPORTED_CANCELLED"
      );
      return;
    case "EXPIRED":
      await dependencies.store.stopPollingForManualReview(
        claim,
        currentTime,
        "PROVIDER_REPORTED_EXPIRED_UNCONFIRMED"
      );
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
    status === TaskStatus.FAILED ||
    status === TaskStatus.CANCELLED ||
    status === TaskStatus.EXPIRED
  );
}

class TaskNoLongerDownloadableError extends Error {}
