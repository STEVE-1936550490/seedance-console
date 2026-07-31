import { Writable } from "node:stream";

import { TaskStatus, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { MockSeedanceProvider } from "@seedance/seedance-provider";
import type { Storage } from "@seedance/storage";

import { createTaskProcessor } from "./task-processor.js";

describe("Mock task processing flow", () => {
  it("moves a persisted task through processing and stores a playable output", async () => {
    const events: TaskStatus[] = [TaskStatus.QUEUED];
    const task = {
      id: "task-1",
      clientRequestId: "request-1",
      provider: "mock",
      providerTaskId: null as string | null,
      model: "mock-video-v1",
      status: TaskStatus.QUEUED,
      prompt: "A calm product shot",
      parameters: {
        ratio: "16:9",
        resolution: "720p",
        duration: "5",
        scenario: "success",
        includeUsage: true
      },
      submittedAt: null as Date | null,
      completedAt: null as Date | null,
      errorCode: null as string | null,
      errorMessage: null as string | null,
      submission: null as {
        providerTaskId: string | null;
        status: string;
        errorCode: string | null;
      } | null,
      assets: [] as { assetId: string }[]
    };
    let outputStored = false;
    let fileStored = false;
    let outputBytes = 0;
    let usageCount = 0;

    const fakePrisma = {
      videoTask: {
        findUnique: async () => task,
        findUniqueOrThrow: async () => task,
        updateMany: async (input: {
          where: { status: TaskStatus; providerTaskId?: null };
          data: {
            status?: TaskStatus;
            providerTaskId?: string;
            submittedAt?: Date;
            completedAt?: Date;
            errorCode?: string | null;
            errorMessage?: string | null;
          };
        }) => {
          if (task.status !== input.where.status) return { count: 0 };
          if (
            input.where.providerTaskId === null &&
            task.providerTaskId !== null
          ) {
            return { count: 0 };
          }
          if (input.data.status !== undefined) task.status = input.data.status;
          if (input.data.providerTaskId !== undefined) {
            task.providerTaskId = input.data.providerTaskId;
          }
          if (input.data.submittedAt !== undefined) {
            task.submittedAt = input.data.submittedAt;
          }
          if (input.data.completedAt !== undefined) {
            task.completedAt = input.data.completedAt;
          }
          if (input.data.errorCode !== undefined) {
            task.errorCode = input.data.errorCode;
          }
          if (input.data.errorMessage !== undefined) {
            task.errorMessage = input.data.errorMessage;
          }
          return { count: 1 };
        },
        update: async (input: {
          data: {
            status?: TaskStatus;
            providerTaskId?: string;
            submittedAt?: Date;
            completedAt?: Date;
          };
        }) => {
          if (input.data.status !== undefined) task.status = input.data.status;
          if (input.data.providerTaskId !== undefined) {
            task.providerTaskId = input.data.providerTaskId;
          }
          if (input.data.submittedAt !== undefined) {
            task.submittedAt = input.data.submittedAt;
          }
          if (input.data.completedAt !== undefined) {
            task.completedAt = input.data.completedAt;
          }
          return task;
        }
      },
      taskEvent: {
        create: async (input: { data: { toStatus: TaskStatus } }) => {
          events.push(input.data.toStatus);
          return input.data;
        }
      },
      providerSubmission: {
        upsert: async (input: {
          create: {
            providerTaskId?: string;
            status: string;
            errorCode?: string;
          };
          update: {
            providerTaskId?: string;
            status: string;
            errorCode?: string | null;
          };
        }) => {
          const data = task.submission === null ? input.create : input.update;
          task.submission = {
            providerTaskId:
              data.providerTaskId ?? task.submission?.providerTaskId ?? null,
            status: data.status,
            errorCode:
              data.errorCode === undefined
                ? (task.submission?.errorCode ?? null)
                : data.errorCode
          };
          return task.submission;
        }
      },
      taskAsset: {
        findFirst: async () => (outputStored ? { assetId: "output-1" } : null),
        create: async () => {
          outputStored = true;
          return { taskId: task.id, assetId: "output-1" };
        }
      },
      asset: {
        create: async () => ({ id: "output-1" })
      },
      usageRecord: {
        createMany: async (input: { data: readonly unknown[] }) => {
          usageCount += input.data.length;
          return { count: input.data.length };
        }
      }
    };

    const transaction = async (
      input:
        | readonly Promise<unknown>[]
        | ((client: typeof fakePrisma) => Promise<unknown>)
    ): Promise<unknown> =>
      typeof input === "function" ? input(fakePrisma) : Promise.all(input);

    const prisma = {
      ...fakePrisma,
      $transaction: transaction
    } as unknown as PrismaClient;

    const storage: Storage = {
      put: async (_storageKey, source) => {
        const sink = new Writable({
          write(chunk: Buffer, _encoding, callback) {
            outputBytes += chunk.length;
            callback();
          }
        });
        await new Promise<void>((resolve, reject) => {
          source.pipe(sink).once("finish", resolve).once("error", reject);
        });
        fileStored = true;
        return { sizeBytes: outputBytes };
      },
      openReadStream: () => {
        throw new Error("Not needed by this test.");
      },
      stat: async () => {
        if (!fileStored) throw new Error("Not found.");
        return { sizeBytes: outputBytes };
      },
      delete: async () => undefined
    };

    const processTask = createTaskProcessor({
      prisma,
      provider: new MockSeedanceProvider(),
      storage,
      pollDelayMs: 1
    });
    await processTask(task.id);

    expect(events).toEqual([
      TaskStatus.QUEUED,
      TaskStatus.SUBMITTING,
      TaskStatus.PROCESSING,
      TaskStatus.SUCCEEDED
    ]);
    expect(task.status).toBe(TaskStatus.SUCCEEDED);
    expect(outputStored).toBe(true);
    expect(outputBytes).toBeGreaterThan(1_000);
    expect(usageCount).toBe(1);
  });

  it("allows only one concurrent worker to create a Provider task", async () => {
    const task = submissionTask(TaskStatus.QUEUED);
    const { prisma } = createSubmissionHarness(task, 2);
    const provider = new MockSeedanceProvider();
    const createSpy = vi.spyOn(provider, "createTask");
    const processTask = createTaskProcessor({
      prisma,
      provider,
      storage: unusedStorage(),
      pollDelayMs: 0
    });

    await Promise.all([processTask(task.id), processTask(task.id)]);

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(task.status).toBe(TaskStatus.PROCESSING);
    expect(task.providerTaskId).toMatch(/^mock-task-/);
    expect(task.submission?.status).toBe("ACCEPTED");
  });

  it("recovers a submitting task from the Provider registry without creating", async () => {
    const provider = new MockSeedanceProvider();
    const task = submissionTask(TaskStatus.SUBMITTING);
    const created = await provider.createTask({
      clientRequestId: task.clientRequestId,
      model: task.model,
      prompt: task.prompt,
      referenceAssetIds: [],
      parameters: task.parameters
    });
    const createSpy = vi.spyOn(provider, "createTask");
    const { prisma } = createSubmissionHarness(task);
    const processTask = createTaskProcessor({
      prisma,
      provider,
      storage: unusedStorage(),
      pollDelayMs: 0
    });

    await processTask(task.id);

    expect(createSpy).not.toHaveBeenCalled();
    expect(task.providerTaskId).toBe(created.providerTaskId);
    expect(task.status).toBe(TaskStatus.PROCESSING);
    expect(task.submission?.status).toBe("ACCEPTED");
  });

  it("keeps an unrecoverable submission pending without creating again", async () => {
    const provider = new MockSeedanceProvider();
    const createSpy = vi.spyOn(provider, "createTask");
    const task = submissionTask(TaskStatus.SUBMITTING);
    const { prisma } = createSubmissionHarness(task);
    const processTask = createTaskProcessor({
      prisma,
      provider,
      storage: unusedStorage(),
      pollDelayMs: 0
    });

    await processTask(task.id);

    expect(createSpy).not.toHaveBeenCalled();
    expect(task.status).toBe(TaskStatus.SUBMITTING);
    expect(task.providerTaskId).toBeNull();
    expect(task.errorCode).toBe("PROVIDER_CREATE_OUTCOME_UNKNOWN");
    expect(task.submission?.status).toBe("OUTCOME_UNKNOWN");
  });

  it("retries only the database write after Provider acceptance", async () => {
    const provider = new MockSeedanceProvider();
    const createSpy = vi.spyOn(provider, "createTask");
    const task = submissionTask(TaskStatus.QUEUED);
    const { prisma } = createSubmissionHarness(task, 0, 2);
    const processTask = createTaskProcessor({
      prisma,
      provider,
      storage: unusedStorage(),
      pollDelayMs: 0
    });

    await expect(processTask(task.id)).rejects.toThrow(
      "Simulated database outage."
    );
    expect(task.status).toBe(TaskStatus.SUBMITTING);
    await processTask(task.id);

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(task.status).toBe(TaskStatus.PROCESSING);
    expect(task.providerTaskId).toMatch(/^mock-task-/);
  });
});

type SubmissionTask = {
  id: string;
  clientRequestId: string;
  provider: string;
  providerTaskId: string | null;
  model: string;
  status: TaskStatus;
  prompt: string;
  parameters: {
    ratio: "16:9";
    resolution: "720p";
    duration: "5";
    scenario: "slow";
    includeUsage: true;
  };
  submittedAt: Date | null;
  completedAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
  submission: {
    providerTaskId: string | null;
    status: string;
    errorCode: string | null;
  } | null;
  assets: { assetId: string }[];
};

function submissionTask(status: TaskStatus): SubmissionTask {
  return {
    id: "submission-task",
    clientRequestId: "submission-request",
    provider: "mock",
    providerTaskId: null,
    model: "mock-video-v1",
    status,
    prompt: "A slow task used to test submission safety",
    parameters: {
      ratio: "16:9",
      resolution: "720p",
      duration: "5",
      scenario: "slow",
      includeUsage: true
    },
    submittedAt: null,
    completedAt: null,
    errorCode: null,
    errorMessage: null,
    submission: null,
    assets: []
  };
}

function createSubmissionHarness(
  task: SubmissionTask,
  synchronizedInitialReads = 0,
  failTransactionNumber = 0
): { prisma: PrismaClient } {
  let reads = 0;
  let releaseReads: (() => void) | undefined;
  const readBarrier =
    synchronizedInitialReads > 0
      ? new Promise<void>((resolve) => {
          releaseReads = resolve;
        })
      : undefined;
  const fakePrisma = {
    videoTask: {
      findUnique: async () => {
        const snapshot = {
          ...task,
          submission: task.submission === null ? null : { ...task.submission },
          assets: [...task.assets]
        };
        if (readBarrier !== undefined && reads < synchronizedInitialReads) {
          reads += 1;
          if (reads === synchronizedInitialReads) releaseReads?.();
          await readBarrier;
        }
        return snapshot;
      },
      updateMany: async (input: {
        where: { status: TaskStatus; providerTaskId?: null };
        data: {
          status?: TaskStatus;
          providerTaskId?: string;
          submittedAt?: Date;
          errorCode?: string | null;
          errorMessage?: string | null;
        };
      }) => {
        if (task.status !== input.where.status) return { count: 0 };
        if (
          input.where.providerTaskId === null &&
          task.providerTaskId !== null
        ) {
          return { count: 0 };
        }
        Object.assign(task, input.data);
        return { count: 1 };
      }
    },
    providerSubmission: {
      upsert: async (input: {
        create: {
          providerTaskId?: string;
          status: string;
          errorCode?: string;
        };
        update: {
          providerTaskId?: string;
          status: string;
          errorCode?: string | null;
        };
      }) => {
        const data = task.submission === null ? input.create : input.update;
        task.submission = {
          providerTaskId:
            data.providerTaskId ?? task.submission?.providerTaskId ?? null,
          status: data.status,
          errorCode:
            data.errorCode === undefined
              ? (task.submission?.errorCode ?? null)
              : data.errorCode
        };
        return task.submission;
      }
    },
    taskEvent: {
      create: async () => ({})
    }
  };
  let transactions = 0;
  const prisma = {
    ...fakePrisma,
    $transaction: async (
      operation: (transaction: typeof fakePrisma) => Promise<unknown>
    ) => {
      transactions += 1;
      if (transactions === failTransactionNumber) {
        throw new Error("Simulated database outage.");
      }
      return operation(fakePrisma);
    }
  } as unknown as PrismaClient;
  return { prisma };
}

function unusedStorage(): Storage {
  return {
    put: async () => {
      throw new Error("Storage is not used for a processing task.");
    },
    openReadStream: () => {
      throw new Error("Storage is not used for a processing task.");
    },
    stat: async () => {
      throw new Error("Storage is not used for a processing task.");
    },
    delete: async () => undefined
  };
}
