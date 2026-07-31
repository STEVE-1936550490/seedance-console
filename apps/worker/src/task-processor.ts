import { TaskStatus } from "@prisma/client";

import {
  ProviderOperationError,
  ProviderOutcomeUnknownError,
  ProviderProtocolError,
  type ProviderTaskSnapshot,
  type SeedanceProvider
} from "@seedance/seedance-provider";
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
