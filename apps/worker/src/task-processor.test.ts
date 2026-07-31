import { Readable } from "node:stream";

import { TaskStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  ProviderAuthenticationError,
  ProviderOutcomeUnknownError,
  ProviderProtocolError,
  ProviderRateLimitError,
  ProviderTransientError,
  type ProviderCapabilities,
  type ProviderDownload,
  type ProviderTaskSnapshot,
  type SeedanceProvider,
  type ValidationResult
} from "@seedance/seedance-provider";

import type { ProviderJobScheduler } from "./job-scheduler.js";
import { createPollCoordinator } from "./poll-coordinator.js";
import type {
  InitialPollSchedule,
  NextPollSchedule,
  PollClaim,
  RecoverablePoll,
  SubmissionTask,
  TaskStore
} from "./task-store.js";
import {
  createPollProcessor,
  createSubmitProcessor,
  type PollingPolicy
} from "./task-processor.js";

const baseTime = new Date("2026-07-31T00:00:00.000Z");
const policy: PollingPolicy = {
  baseIntervalMs: 1_000,
  maxIntervalMs: 8_000,
  maxDurationMs: 60_000,
  requestTimeoutMs: 5_000,
  jitterRatio: 0.1
};

describe("split Provider submit and poll processing", () => {
  it("submit persists the first schedule and only enqueues a poll", async () => {
    const harness = createHarness();

    await harness.submit("task-1");

    expect(harness.provider.createCalls).toBe(1);
    expect(harness.provider.getCalls).toBe(0);
    expect(harness.store.task.status).toBe(TaskStatus.PROCESSING);
    expect(harness.store.task.pollVersion).toBe(1);
    expect(harness.scheduler.polls).toEqual([
      {
        taskId: "task-1",
        pollVersion: 1,
        runAt: new Date("2026-07-31T00:00:01.000Z")
      }
    ]);
    expect(harness.scheduler.downloads).toEqual([]);
  });

  it("allows only one concurrent submit job to create a Provider task", async () => {
    const harness = createHarness();

    await Promise.all([harness.submit("task-1"), harness.submit("task-1")]);

    expect(harness.provider.createCalls).toBe(1);
    expect(harness.store.task.status).toBe(TaskStatus.PROCESSING);
    expect(harness.scheduler.polls).toHaveLength(1);
  });

  it("recovers a submitting task without calling create again", async () => {
    const harness = createHarness({ recoveredId: "provider-task-recovered" });
    harness.store.task.status = TaskStatus.SUBMITTING;

    await harness.submit("task-1");

    expect(harness.provider.createCalls).toBe(0);
    expect(harness.provider.recoverCalls).toBe(1);
    expect(harness.store.task.providerTaskId).toBe("provider-task-recovered");
    expect(harness.scheduler.polls).toHaveLength(1);
  });

  it("keeps an unknown create outcome submitting without retrying", async () => {
    const harness = createHarness({
      createError: new ProviderOutcomeUnknownError()
    });

    await harness.submit("task-1");

    expect(harness.provider.createCalls).toBe(1);
    expect(harness.provider.recoverCalls).toBe(1);
    expect(harness.store.task.status).toBe(TaskStatus.SUBMITTING);
    expect(harness.store.task.errorCode).toBe(
      "PROVIDER_CREATE_OUTCOME_UNKNOWN"
    );
    expect(harness.scheduler.polls).toEqual([]);
  });

  it("retries only persistence after Provider acceptance", async () => {
    const harness = createHarness({ failAcceptanceOnce: true });

    await expect(harness.submit("task-1")).rejects.toThrow(
      "Simulated database outage."
    );
    await harness.submit("task-1");

    expect(harness.provider.createCalls).toBe(1);
    expect(harness.provider.recoverCalls).toBe(1);
    expect(harness.store.task.status).toBe(TaskStatus.PROCESSING);
    expect(harness.store.task.providerTaskId).toBe("provider-task-1");
  });

  it("moves pending to running to output-ready without marking succeeded", async () => {
    const harness = createHarness({
      snapshots: [
        processingSnapshot("pending"),
        processingSnapshot("running"),
        succeededSnapshot()
      ]
    });
    await harness.submit("task-1");

    await runCurrentPoll(harness);
    await runCurrentPoll(harness);
    await runCurrentPoll(harness);

    expect(harness.provider.getCalls).toBe(3);
    expect(harness.store.task.status).toBe(TaskStatus.PROCESSING);
    expect(harness.store.task.downloadPending).toBe(true);
    expect(harness.store.task.nextPollAt).toBeNull();
    expect(harness.scheduler.downloads).toEqual(["task-1"]);
  });

  it("stops polling after a Provider failure", async () => {
    const harness = createHarness({ snapshots: [failedSnapshot()] });
    await harness.submit("task-1");
    await runCurrentPoll(harness);

    expect(harness.store.task.status).toBe(TaskStatus.FAILED);
    expect(harness.store.task.nextPollAt).toBeNull();
    expect(harness.scheduler.polls).toHaveLength(1);
  });

  it("backs off after 429 and respects Retry-After", async () => {
    const harness = createHarness({
      snapshots: [new ProviderRateLimitError("GET", "SAFE_READ", 5_000)]
    });
    await harness.submit("task-1");
    harness.setNow(new Date("2026-07-31T00:00:01.000Z"));
    await runCurrentPoll(harness);

    expect(harness.store.task.pollTransientErrors).toBe(1);
    expect(harness.store.task.nextPollAt).toEqual(
      new Date("2026-07-31T00:00:06.000Z")
    );
  });

  it("backs off exponentially after retryable 5xx errors", async () => {
    const harness = createHarness({
      snapshots: [
        new ProviderTransientError("GET", { statusCode: 503 }),
        new ProviderTransientError("GET", { statusCode: 503 })
      ]
    });
    await harness.submit("task-1");
    harness.setNow(new Date("2026-07-31T00:00:01.000Z"));
    await runCurrentPoll(harness);
    expect(delayFrom(harness.now(), harness.store.task.nextPollAt)).toBe(2_000);

    harness.setNow(harness.store.task.nextPollAt as Date);
    await runCurrentPoll(harness);
    expect(delayFrom(harness.now(), harness.store.task.nextPollAt)).toBe(4_000);
  });

  it.each([401, 403])(
    "stops automatic polling on authentication error %s",
    async (statusCode) => {
      const harness = createHarness({
        snapshots: [new ProviderAuthenticationError("GET", statusCode)]
      });
      await harness.submit("task-1");
      await runCurrentPoll(harness);

      expect(harness.store.task.status).toBe(TaskStatus.PROCESSING);
      expect(harness.store.task.nextPollAt).toBeNull();
      expect(harness.store.task.lastPollError).toBe(
        "PROVIDER_AUTHENTICATION_FAILED"
      );
    }
  );

  it("does not guess an unknown Provider status", async () => {
    const harness = createHarness({
      snapshots: [
        new ProviderProtocolError("NORMALIZE", "Unknown fixture status.")
      ]
    });
    await harness.submit("task-1");
    await runCurrentPoll(harness);

    expect(harness.store.task.status).toBe(TaskStatus.PROCESSING);
    expect(harness.store.task.downloadPending).toBe(false);
    expect(harness.store.task.nextPollAt).toBeNull();
    expect(harness.store.task.lastPollError).toBe("PROVIDER_PROTOCOL_ERROR");
  });

  it("stops when succeeded has no available video output", async () => {
    const harness = createHarness({
      snapshots: [
        {
          providerTaskId: "provider-task-1",
          status: "SUCCEEDED",
          outputs: [],
          usage: []
        }
      ]
    });
    await harness.submit("task-1");
    await runCurrentPoll(harness);

    expect(harness.store.task.status).toBe(TaskStatus.PROCESSING);
    expect(harness.store.task.downloadPending).toBe(false);
    expect(harness.store.task.lastPollError).toBe("PROVIDER_PROTOCOL_ERROR");
  });

  it("lets only one duplicate poll job query the Provider", async () => {
    const harness = createHarness({
      snapshots: [processingSnapshot("running")]
    });
    await harness.submit("task-1");
    const version = harness.store.task.pollVersion;
    harness.setNow(harness.store.task.nextPollAt as Date);

    await Promise.all([
      harness.poll("task-1", version),
      harness.poll("task-1", version)
    ]);

    expect(harness.provider.getCalls).toBe(1);
    expect(harness.store.task.pollVersion).toBe(2);
  });

  it("ignores stale poll versions", async () => {
    const harness = createHarness();
    await harness.submit("task-1");
    await harness.poll("task-1", 0);

    expect(harness.provider.getCalls).toBe(0);
    expect(harness.store.task.pollVersion).toBe(1);
  });

  it("ignores a delayed job left behind after the database version advances", async () => {
    const harness = createHarness();
    await harness.submit("task-1");
    harness.store.task.pollVersion = 2;
    await harness.poll("task-1", 1);

    expect(harness.provider.getCalls).toBe(0);
  });

  it("does not let an in-flight result overwrite local cancellation", async () => {
    const harness = createHarness({
      snapshots: [succeededSnapshot()],
      beforeSnapshotReturn: () => {
        harness.store.task.status = TaskStatus.CANCELLED;
      }
    });
    await harness.submit("task-1");
    await runCurrentPoll(harness);

    expect(harness.store.task.status).toBe(TaskStatus.CANCELLED);
    expect(harness.store.task.downloadPending).toBe(false);
    expect(harness.scheduler.downloads).toEqual([]);
  });

  it("expires locally at the polling deadline without querying again", async () => {
    const harness = createHarness();
    await harness.submit("task-1");
    harness.setNow(harness.store.task.pollDeadlineAt as Date);
    harness.store.task.nextPollAt = harness.now();
    await runCurrentPoll(harness);

    expect(harness.provider.getCalls).toBe(0);
    expect(harness.store.task.status).toBe(TaskStatus.EXPIRED);
    expect(harness.store.task.lastPollError).toBe(
      "LOCAL_POLL_DEADLINE_EXCEEDED"
    );
  });

  it("recovers a missing Redis poll job from persisted scheduling state", async () => {
    const harness = createHarness();
    await harness.submit("task-1");
    harness.scheduler.polls.length = 0;
    harness.setNow(harness.store.task.nextPollAt as Date);

    await harness.reconcile();

    expect(harness.scheduler.polls).toEqual([
      {
        taskId: "task-1",
        pollVersion: 1,
        runAt: harness.store.task.nextPollAt
      }
    ]);
    expect(harness.provider.createCalls).toBe(1);
  });

  it("recovers after database commit succeeds but queue scheduling fails", async () => {
    const harness = createHarness({
      snapshots: [processingSnapshot("running")]
    });
    await harness.submit("task-1");
    harness.scheduler.failNextPoll = true;
    harness.setNow(harness.store.task.nextPollAt as Date);
    await runCurrentPoll(harness);
    expect(harness.store.task.pollVersion).toBe(2);

    harness.scheduler.polls.length = 0;
    harness.setNow(harness.store.task.nextPollAt as Date);
    await harness.reconcile();

    expect(harness.scheduler.polls[0]).toMatchObject({
      taskId: "task-1",
      pollVersion: 2
    });
  });

  it("coordinator restores pending download jobs without polling", async () => {
    const harness = createHarness({ snapshots: [succeededSnapshot()] });
    await harness.submit("task-1");
    await runCurrentPoll(harness);
    harness.scheduler.downloads.length = 0;

    await harness.reconcile();

    expect(harness.scheduler.downloads).toEqual(["task-1"]);
    expect(harness.provider.getCalls).toBe(1);
  });
});

function createHarness(
  options: {
    snapshots?: Array<ProviderTaskSnapshot | Error>;
    beforeSnapshotReturn?: () => void;
    recoveredId?: string;
    createError?: Error;
    failAcceptanceOnce?: boolean;
  } = {}
) {
  let currentTime = baseTime;
  const store = new MemoryTaskStore();
  store.failAcceptanceOnce = options.failAcceptanceOnce ?? false;
  const scheduler = new MemoryScheduler();
  const provider = new ScriptedProvider(
    options.snapshots ?? [],
    options.beforeSnapshotReturn,
    options.recoveredId,
    options.createError
  );
  const clock = () => new Date(currentTime);
  const dependencies = {
    store,
    provider,
    scheduler,
    policy,
    now: clock,
    random: () => 0.5
  };
  return {
    store,
    scheduler,
    provider,
    now: clock,
    setNow(value: Date) {
      currentTime = new Date(value);
    },
    submit: createSubmitProcessor(dependencies),
    poll: createPollProcessor(dependencies),
    reconcile: createPollCoordinator({
      store,
      scheduler,
      batchSize: 10,
      now: clock
    })
  };
}

async function runCurrentPoll(
  harness: ReturnType<typeof createHarness>
): Promise<void> {
  harness.setNow(harness.store.task.nextPollAt as Date);
  await harness.poll("task-1", harness.store.task.pollVersion);
}

function delayFrom(now: Date, next: Date | null): number {
  return (next as Date).getTime() - now.getTime();
}

function processingSnapshot(providerStatus: string): ProviderTaskSnapshot {
  return {
    providerTaskId: "provider-task-1",
    status: "PROCESSING",
    outputs: [],
    usage: [],
    debug: { providerStatus }
  };
}

function succeededSnapshot(): ProviderTaskSnapshot {
  return {
    providerTaskId: "provider-task-1",
    status: "SUCCEEDED",
    outputs: [{ kind: "video", available: true }],
    usage: []
  };
}

function failedSnapshot(): ProviderTaskSnapshot {
  return {
    providerTaskId: "provider-task-1",
    status: "FAILED",
    outputs: [],
    usage: [],
    error: {
      code: "PROVIDER_TASK_FAILED",
      message: "Provider task failed.",
      retryable: false
    }
  };
}

type MemoryTask = SubmissionTask & {
  pollVersion: number;
  pollAttempt: number;
  pollTransientErrors: number;
  pollStartedAt: Date | null;
  nextPollAt: Date | null;
  lastPolledAt: Date | null;
  pollDeadlineAt: Date | null;
  pollLeaseUntil: Date | null;
  lastProviderStatus: string | null;
  lastPollError: string | null;
  downloadPending: boolean;
  errorCode: string | null;
};

class MemoryTaskStore implements TaskStore {
  failAcceptanceOnce = false;
  readonly task: MemoryTask = {
    id: "task-1",
    provider: "mock",
    clientRequestId: "request-1",
    providerTaskId: null,
    status: TaskStatus.QUEUED,
    model: "mock-video-v1",
    prompt: "Fixture prompt",
    parameters: {
      ratio: "16:9",
      resolution: "720p",
      duration: "5",
      scenario: "slow",
      includeUsage: true
    },
    referenceAssetIds: [],
    recoveredProviderTaskId: null,
    pollVersion: 0,
    pollAttempt: 0,
    pollTransientErrors: 0,
    pollStartedAt: null,
    nextPollAt: null,
    lastPolledAt: null,
    pollDeadlineAt: null,
    pollLeaseUntil: null,
    lastProviderStatus: null,
    lastPollError: null,
    downloadPending: false,
    errorCode: null
  };

  async loadSubmissionTask(taskId: string): Promise<SubmissionTask | null> {
    return taskId === this.task.id ? { ...this.task } : null;
  }

  async claimSubmission(task: SubmissionTask): Promise<boolean> {
    if (
      this.task.id !== task.id ||
      this.task.status !== TaskStatus.QUEUED ||
      this.task.providerTaskId !== null
    ) {
      return false;
    }
    this.task.status = TaskStatus.SUBMITTING;
    return true;
  }

  async acceptSubmission(
    task: SubmissionTask,
    providerTaskId: string,
    schedule: InitialPollSchedule
  ): Promise<boolean> {
    if (this.failAcceptanceOnce) {
      this.failAcceptanceOnce = false;
      throw new Error("Simulated database outage.");
    }
    if (
      this.task.id !== task.id ||
      this.task.status !== TaskStatus.SUBMITTING ||
      this.task.providerTaskId !== null
    ) {
      return false;
    }
    Object.assign(this.task, {
      status: TaskStatus.PROCESSING,
      providerTaskId,
      recoveredProviderTaskId: providerTaskId,
      pollStartedAt: schedule.now,
      nextPollAt: schedule.nextPollAt,
      pollDeadlineAt: schedule.pollDeadlineAt,
      pollVersion: schedule.pollVersion,
      pollAttempt: 0,
      pollTransientErrors: 0
    });
    return true;
  }

  async markSubmissionOutcomeUnknown(): Promise<void> {
    this.task.errorCode = "PROVIDER_CREATE_OUTCOME_UNKNOWN";
  }

  async claimPoll(
    taskId: string,
    pollVersion: number,
    now: Date,
    leaseUntil: Date
  ): Promise<PollClaim | null> {
    if (
      taskId !== this.task.id ||
      this.task.status !== TaskStatus.PROCESSING ||
      this.task.providerTaskId === null ||
      this.task.pollVersion !== pollVersion ||
      this.task.nextPollAt === null ||
      this.task.nextPollAt > now ||
      this.task.downloadPending ||
      (this.task.pollLeaseUntil !== null && this.task.pollLeaseUntil > now) ||
      this.task.pollDeadlineAt === null
    ) {
      return null;
    }
    this.task.pollLeaseUntil = leaseUntil;
    return {
      taskId,
      providerTaskId: this.task.providerTaskId,
      pollVersion,
      pollAttempt: this.task.pollAttempt,
      transientErrors: this.task.pollTransientErrors,
      pollDeadlineAt: this.task.pollDeadlineAt,
      leaseUntil
    };
  }

  async scheduleNextPoll(
    claim: PollClaim,
    schedule: NextPollSchedule
  ): Promise<boolean> {
    if (!this.isCurrentClaim(claim)) return false;
    Object.assign(this.task, {
      pollVersion: claim.pollVersion + 1,
      pollAttempt: this.task.pollAttempt + 1,
      pollTransientErrors: schedule.transientErrors,
      nextPollAt: schedule.nextPollAt,
      lastPolledAt: schedule.now,
      pollLeaseUntil: null,
      lastProviderStatus: schedule.providerStatus ?? null,
      lastPollError: schedule.lastPollError ?? null
    });
    return true;
  }

  async markDownloadPending(
    claim: PollClaim,
    now: Date,
    providerStatus?: string
  ): Promise<boolean> {
    if (!this.isCurrentClaim(claim)) return false;
    Object.assign(this.task, {
      pollAttempt: this.task.pollAttempt + 1,
      nextPollAt: null,
      lastPolledAt: now,
      pollLeaseUntil: null,
      lastProviderStatus: providerStatus ?? null,
      lastPollError: null,
      downloadPending: true
    });
    return true;
  }

  async markProviderFailed(
    claim: PollClaim,
    now: Date,
    errorCode: string,
    _errorMessage: string,
    providerStatus?: string
  ): Promise<boolean> {
    if (!this.isCurrentClaim(claim)) return false;
    Object.assign(this.task, {
      status: TaskStatus.FAILED,
      nextPollAt: null,
      lastPolledAt: now,
      pollLeaseUntil: null,
      lastProviderStatus: providerStatus ?? null,
      errorCode
    });
    return true;
  }

  async stopPollingForManualReview(
    claim: PollClaim,
    _now: Date,
    errorCode: string
  ): Promise<boolean> {
    if (!this.isCurrentClaim(claim)) return false;
    Object.assign(this.task, {
      nextPollAt: null,
      pollLeaseUntil: null,
      lastPollError: errorCode,
      errorCode
    });
    return true;
  }

  async expireLocalPoll(claim: PollClaim): Promise<boolean> {
    if (!this.isCurrentClaim(claim)) return false;
    Object.assign(this.task, {
      status: TaskStatus.EXPIRED,
      nextPollAt: null,
      pollLeaseUntil: null,
      lastPollError: "LOCAL_POLL_DEADLINE_EXCEEDED",
      errorCode: "LOCAL_POLL_DEADLINE_EXCEEDED"
    });
    return true;
  }

  async findRecoverablePolls(
    now: Date,
    limit: number
  ): Promise<readonly RecoverablePoll[]> {
    return this.task.status === TaskStatus.PROCESSING &&
      this.task.providerTaskId !== null &&
      !this.task.downloadPending &&
      this.task.nextPollAt !== null &&
      this.task.nextPollAt <= now &&
      (this.task.pollLeaseUntil === null || this.task.pollLeaseUntil <= now)
      ? [
          {
            taskId: this.task.id,
            pollVersion: this.task.pollVersion,
            nextPollAt: this.task.nextPollAt
          }
        ].slice(0, limit)
      : [];
  }

  async findPendingDownloads(): Promise<readonly string[]> {
    return this.task.status === TaskStatus.PROCESSING &&
      this.task.downloadPending
      ? [this.task.id]
      : [];
  }

  private isCurrentClaim(claim: PollClaim): boolean {
    return (
      this.task.status === TaskStatus.PROCESSING &&
      this.task.providerTaskId === claim.providerTaskId &&
      this.task.pollVersion === claim.pollVersion &&
      this.task.pollLeaseUntil?.getTime() === claim.leaseUntil.getTime() &&
      !this.task.downloadPending
    );
  }
}

class MemoryScheduler implements ProviderJobScheduler {
  readonly polls: {
    taskId: string;
    pollVersion: number;
    runAt: Date;
  }[] = [];
  readonly downloads: string[] = [];
  failNextPoll = false;

  async schedulePoll(
    taskId: string,
    pollVersion: number,
    runAt: Date
  ): Promise<void> {
    if (this.failNextPoll) {
      this.failNextPoll = false;
      throw new Error("Simulated Redis outage.");
    }
    this.polls.push({ taskId, pollVersion, runAt });
  }

  async scheduleDownload(taskId: string): Promise<void> {
    this.downloads.push(taskId);
  }
}

class ScriptedProvider implements SeedanceProvider {
  readonly name = "mock" as const;
  createCalls = 0;
  getCalls = 0;
  recoverCalls = 0;
  private readonly snapshots: Array<ProviderTaskSnapshot | Error>;
  private createdTaskId: string | undefined;

  constructor(
    snapshots: Array<ProviderTaskSnapshot | Error>,
    private readonly beforeSnapshotReturn?: () => void,
    private readonly recoveredId?: string,
    private readonly createError?: Error
  ) {
    this.snapshots = [...snapshots];
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return {
      provider: "mock",
      label: "Fixture",
      testOnly: true,
      supportsCancellation: false,
      acceptedAssetTypes: [],
      models: []
    };
  }

  validateParameters(): ValidationResult {
    return { ok: true, value: {} };
  }

  async createTask(): Promise<ProviderTaskSnapshot> {
    this.createCalls += 1;
    if (this.createError !== undefined) throw this.createError;
    this.createdTaskId = "provider-task-1";
    return processingSnapshot("queued");
  }

  async recoverTask(): Promise<string | null> {
    this.recoverCalls += 1;
    return this.recoveredId ?? this.createdTaskId ?? null;
  }

  async getTask(): Promise<ProviderTaskSnapshot> {
    this.getCalls += 1;
    const value = this.snapshots.shift() ?? processingSnapshot("running");
    this.beforeSnapshotReturn?.();
    if (value instanceof Error) throw value;
    return value;
  }

  async cancelTask(): Promise<ProviderTaskSnapshot> {
    throw new Error("Cancellation is not used.");
  }

  normalizeStatus(): ProviderTaskSnapshot["status"] {
    return "PROCESSING";
  }

  normalizeUsage() {
    return [];
  }

  async downloadOutput(): Promise<ProviderDownload> {
    return { body: Readable.from(Buffer.from("fixture")) };
  }
}
