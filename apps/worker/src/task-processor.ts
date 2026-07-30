import { setTimeout as delay } from "node:timers/promises";

import {
  AssetKind,
  AssetRole,
  Prisma,
  TaskStatus,
  type PrismaClient
} from "@prisma/client";

import {
  openMockVideoFixture,
  type SeedanceProvider
} from "@seedance/seedance-provider";
import type { Storage } from "@seedance/storage";

const terminalStatuses = new Set<TaskStatus>([
  TaskStatus.SUCCEEDED,
  TaskStatus.FAILED,
  TaskStatus.CANCELLED,
  TaskStatus.EXPIRED
]);

export interface TaskProcessorDependencies {
  prisma: PrismaClient;
  provider: SeedanceProvider;
  storage: Storage;
  pollDelayMs?: number;
}

export function createTaskProcessor(dependencies: TaskProcessorDependencies) {
  return async (taskId: string): Promise<void> => {
    const initialTask = await dependencies.prisma.videoTask.findUnique({
      where: { id: taskId },
      include: {
        assets: {
          where: { role: AssetRole.REFERENCE_IMAGE }
        }
      }
    });
    if (initialTask === null || terminalStatuses.has(initialTask.status)) {
      return;
    }

    try {
      if (initialTask.status === TaskStatus.QUEUED) {
        await transition(
          dependencies.prisma,
          taskId,
          TaskStatus.QUEUED,
          TaskStatus.SUBMITTING,
          "WORKER_STARTED"
        );
      }

      const snapshot = await dependencies.provider.createTask({
        clientRequestId: initialTask.clientRequestId,
        model: initialTask.model,
        prompt: initialTask.prompt,
        referenceAssetIds: initialTask.assets.map(
          (relation) => relation.assetId
        ),
        parameters: initialTask.parameters
      });

      const current = await dependencies.prisma.videoTask.findUniqueOrThrow({
        where: { id: taskId }
      });
      if (current.status === TaskStatus.SUBMITTING) {
        await dependencies.prisma.$transaction([
          dependencies.prisma.videoTask.update({
            where: { id: taskId },
            data: {
              status: TaskStatus.PROCESSING,
              providerTaskId: snapshot.providerTaskId,
              submittedAt: current.submittedAt ?? new Date()
            }
          }),
          dependencies.prisma.taskEvent.create({
            data: {
              taskId,
              fromStatus: TaskStatus.SUBMITTING,
              toStatus: TaskStatus.PROCESSING,
              reason: "PROVIDER_ACCEPTED"
            }
          })
        ]);
      }

      const pollDelayMs = dependencies.pollDelayMs ?? 1_500;
      let latest = snapshot;
      for (
        let poll = 0;
        poll < 2 && latest.status === "PROCESSING";
        poll += 1
      ) {
        await delay(pollDelayMs);
        latest = await dependencies.provider.getTask(snapshot.providerTaskId);
      }

      if (latest.status === "PROCESSING") {
        return;
      }
      if (latest.status === "FAILED") {
        await failTask(
          dependencies.prisma,
          taskId,
          latest.error?.code ?? "MOCK_PROVIDER_FAILED",
          latest.error?.message ?? "Mock Provider 任务失败。"
        );
        return;
      }
      if (latest.status === "CANCELLED") {
        await transition(
          dependencies.prisma,
          taskId,
          TaskStatus.PROCESSING,
          TaskStatus.CANCELLED,
          "PROVIDER_CANCELLED"
        );
        return;
      }

      const existingOutput = await dependencies.prisma.taskAsset.findFirst({
        where: { taskId, role: AssetRole.GENERATED_VIDEO }
      });
      if (existingOutput === null) {
        const storageKey = `outputs/${taskId}.mp4`;
        const stored = await dependencies.storage
          .stat(storageKey)
          .catch(() =>
            dependencies.storage.put(storageKey, openMockVideoFixture())
          );
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
          if (latest.usage.length > 0) {
            await transaction.usageRecord.createMany({
              data: latest.usage.map((usage) => ({
                taskId,
                provider: dependencies.provider.name,
                metric: usage.metric,
                quantity: new Prisma.Decimal(usage.quantity),
                unit: usage.unit,
                raw: {
                  source: "mock",
                  testOnly: true
                }
              }))
            });
          }
          await transaction.videoTask.update({
            where: { id: taskId },
            data: {
              status: TaskStatus.SUCCEEDED,
              completedAt: new Date()
            }
          });
          await transaction.taskEvent.create({
            data: {
              taskId,
              fromStatus: TaskStatus.PROCESSING,
              toStatus: TaskStatus.SUCCEEDED,
              reason: "OUTPUT_STORED"
            }
          });
        });
      }
    } catch (error) {
      await failTask(
        dependencies.prisma,
        taskId,
        "MOCK_WORKER_ERROR",
        error instanceof Error ? error.message : "Worker 执行失败。"
      );
    }
  };
}

async function transition(
  prisma: PrismaClient,
  taskId: string,
  fromStatus: TaskStatus,
  toStatus: TaskStatus,
  reason: string
): Promise<void> {
  await prisma.$transaction(async (transaction) => {
    const updated = await transaction.videoTask.updateMany({
      where: { id: taskId, status: fromStatus },
      data: { status: toStatus }
    });
    if (updated.count === 1) {
      await transaction.taskEvent.create({
        data: { taskId, fromStatus, toStatus, reason }
      });
    }
  });
}

async function failTask(
  prisma: PrismaClient,
  taskId: string,
  errorCode: string,
  errorMessage: string
): Promise<void> {
  const task = await prisma.videoTask.findUnique({ where: { id: taskId } });
  if (task === null || terminalStatuses.has(task.status)) {
    return;
  }
  await prisma.$transaction([
    prisma.videoTask.update({
      where: { id: taskId },
      data: {
        status: TaskStatus.FAILED,
        errorCode,
        errorMessage,
        completedAt: new Date()
      }
    }),
    prisma.taskEvent.create({
      data: {
        taskId,
        fromStatus: task.status,
        toStatus: TaskStatus.FAILED,
        reason: errorCode
      }
    })
  ]);
}
