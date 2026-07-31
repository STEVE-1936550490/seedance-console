import { Writable } from "node:stream";

import { TaskStatus, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { MockSeedanceProvider } from "@seedance/seedance-provider";
import type { Storage } from "@seedance/storage";

import { createDownloadProcessor } from "./task-processor.js";

describe("Mock download compatibility boundary", () => {
  it("stores the Mock output before marking the task succeeded", async () => {
    const provider = new MockSeedanceProvider();
    const created = await provider.createTask({
      clientRequestId: "download-request",
      model: "mock-video-v1",
      prompt: "Download fixture",
      referenceAssetIds: [],
      parameters: {
        ratio: "16:9",
        resolution: "720p",
        duration: "5",
        scenario: "success",
        includeUsage: true
      }
    });
    await provider.getTask(created.providerTaskId);
    await provider.getTask(created.providerTaskId);
    const downloadSpy = vi.spyOn(provider, "downloadOutput");
    const task = {
      id: "task-1",
      status: TaskStatus.PROCESSING,
      providerTaskId: created.providerTaskId,
      downloadPending: true,
      completedAt: null as Date | null
    };
    let outputStored = false;
    let fileStored = false;
    let outputBytes = 0;
    let usageCount = 0;

    const fakePrisma = {
      videoTask: {
        findUnique: async () => task,
        updateMany: async (input: {
          where: {
            status: TaskStatus;
            downloadPending: boolean;
            providerTaskId: string;
          };
          data: {
            status: TaskStatus;
            downloadPending: boolean;
            completedAt: Date;
          };
        }) => {
          if (
            task.status !== input.where.status ||
            task.downloadPending !== input.where.downloadPending ||
            task.providerTaskId !== input.where.providerTaskId
          ) {
            return { count: 0 };
          }
          Object.assign(task, input.data);
          return { count: 1 };
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
      },
      taskEvent: {
        create: async () => ({})
      }
    };
    const prisma = {
      ...fakePrisma,
      $transaction: async (
        operation: (transaction: typeof fakePrisma) => Promise<unknown>
      ) => operation(fakePrisma)
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
    const processDownload = createDownloadProcessor({
      prisma,
      provider,
      storage,
      now: () => new Date("2026-07-31T00:00:00.000Z")
    });

    await processDownload(task.id);

    expect(downloadSpy).toHaveBeenCalledTimes(1);
    expect(outputStored).toBe(true);
    expect(outputBytes).toBeGreaterThan(1_000);
    expect(usageCount).toBe(1);
    expect(task.status).toBe(TaskStatus.SUCCEEDED);
    expect(task.downloadPending).toBe(false);
  });
});
