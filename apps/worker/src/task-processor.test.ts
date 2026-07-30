import { Writable } from "node:stream";

import { TaskStatus, type PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

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
          where: { status: TaskStatus };
          data: { status: TaskStatus };
        }) => {
          if (task.status !== input.where.status) return { count: 0 };
          task.status = input.data.status;
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
});
