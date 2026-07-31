import { setTimeout as delay } from "node:timers/promises";

import {
  AssetKind,
  AssetRole,
  Prisma,
  ProviderSubmissionStatus,
  TaskStatus,
  type PrismaClient
} from "@prisma/client";

import {
  openMockVideoFixture,
  ProviderOutcomeUnknownError,
  type ProviderTaskSnapshot,
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
    let providerAccepted = false;
    const initialTask = await dependencies.prisma.videoTask.findUnique({
      where: { id: taskId },
      include: {
        submission: true,
        assets: {
          where: { role: AssetRole.REFERENCE_IMAGE }
        }
      }
    });
    if (initialTask === null || terminalStatuses.has(initialTask.status)) {
      return;
    }

    try {
      let snapshot: ProviderTaskSnapshot;
      if (initialTask.status === TaskStatus.QUEUED) {
        const claimed = await claimSubmission(dependencies.prisma, initialTask);
        if (!claimed) return;
        try {
          snapshot = await dependencies.provider.createTask({
            clientRequestId: initialTask.clientRequestId,
            model: initialTask.model,
            prompt: initialTask.prompt,
            referenceAssetIds: initialTask.assets.map(
              (relation) => relation.assetId
            ),
            parameters: initialTask.parameters
          });
        } catch (error) {
          if (error instanceof ProviderOutcomeUnknownError) {
            const recoveredId = await dependencies.provider.recoverTask(
              initialTask.clientRequestId
            );
            if (recoveredId === null) {
              await markSubmissionOutcomeUnknown(
                dependencies.prisma,
                initialTask
              );
              return;
            }
            snapshot = await dependencies.provider.getTask(recoveredId);
          } else {
            throw error;
          }
        }
        providerAccepted = true;
        if (
          !(await persistProviderAcceptance(
            dependencies.prisma,
            initialTask,
            snapshot.providerTaskId
          ))
        ) {
          return;
        }
      } else if (initialTask.status === TaskStatus.SUBMITTING) {
        const recoveredId =
          initialTask.submission?.providerTaskId ??
          (await dependencies.provider.recoverTask(
            initialTask.clientRequestId
          ));
        if (recoveredId === null) {
          await markSubmissionOutcomeUnknown(dependencies.prisma, initialTask);
          return;
        }
        providerAccepted = true;
        if (
          !(await persistProviderAcceptance(
            dependencies.prisma,
            initialTask,
            recoveredId
          ))
        ) {
          return;
        }
        snapshot = await dependencies.provider.getTask(recoveredId);
      } else if (
        initialTask.status === TaskStatus.PROCESSING &&
        initialTask.providerTaskId !== null
      ) {
        snapshot = await dependencies.provider.getTask(
          initialTask.providerTaskId
        );
      } else {
        return;
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
          const completed = await transaction.videoTask.updateMany({
            where: {
              id: taskId,
              status: TaskStatus.PROCESSING
            },
            data: {
              status: TaskStatus.SUCCEEDED,
              completedAt: new Date()
            }
          });
          if (completed.count !== 1) {
            throw new TaskNoLongerProcessingError();
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
      }
    } catch (error) {
      if (providerAccepted) {
        throw error;
      }
      await failTask(
        dependencies.prisma,
        taskId,
        "MOCK_WORKER_ERROR",
        error instanceof Error ? error.message : "Worker 执行失败。"
      );
    }
  };
}

class TaskNoLongerProcessingError extends Error {}

async function claimSubmission(
  prisma: PrismaClient,
  task: {
    id: string;
    provider: string;
    clientRequestId: string;
  }
): Promise<boolean> {
  return prisma.$transaction(async (transaction) => {
    const claimed = await transaction.videoTask.updateMany({
      where: {
        id: task.id,
        status: TaskStatus.QUEUED,
        providerTaskId: null
      },
      data: { status: TaskStatus.SUBMITTING }
    });
    if (claimed.count !== 1) return false;
    await transaction.providerSubmission.upsert({
      where: { taskId: task.id },
      create: {
        taskId: task.id,
        provider: task.provider,
        clientRequestId: task.clientRequestId,
        status: ProviderSubmissionStatus.ATTEMPTING
      },
      update: {
        status: ProviderSubmissionStatus.ATTEMPTING,
        errorCode: null
      }
    });
    await transaction.taskEvent.create({
      data: {
        taskId: task.id,
        fromStatus: TaskStatus.QUEUED,
        toStatus: TaskStatus.SUBMITTING,
        reason: "WORKER_STARTED"
      }
    });
    return true;
  });
}

async function persistProviderAcceptance(
  prisma: PrismaClient,
  task: {
    id: string;
    provider: string;
    clientRequestId: string;
  },
  providerTaskId: string
): Promise<boolean> {
  return prisma.$transaction(async (transaction) => {
    const acceptedAt = new Date();
    const accepted = await transaction.videoTask.updateMany({
      where: {
        id: task.id,
        status: TaskStatus.SUBMITTING,
        providerTaskId: null
      },
      data: {
        status: TaskStatus.PROCESSING,
        providerTaskId,
        submittedAt: acceptedAt,
        errorCode: null,
        errorMessage: null
      }
    });
    await transaction.providerSubmission.upsert({
      where: { taskId: task.id },
      create: {
        taskId: task.id,
        provider: task.provider,
        clientRequestId: task.clientRequestId,
        providerTaskId,
        status: ProviderSubmissionStatus.ACCEPTED,
        acceptedAt
      },
      update: {
        providerTaskId,
        status: ProviderSubmissionStatus.ACCEPTED,
        acceptedAt,
        errorCode: null
      }
    });
    if (accepted.count !== 1) return false;
    await transaction.taskEvent.create({
      data: {
        taskId: task.id,
        fromStatus: TaskStatus.SUBMITTING,
        toStatus: TaskStatus.PROCESSING,
        reason: "PROVIDER_ACCEPTED"
      }
    });
    return true;
  });
}

async function markSubmissionOutcomeUnknown(
  prisma: PrismaClient,
  task: {
    id: string;
    provider: string;
    clientRequestId: string;
  }
): Promise<void> {
  await prisma.$transaction(async (transaction) => {
    const marked = await transaction.videoTask.updateMany({
      where: {
        id: task.id,
        status: TaskStatus.SUBMITTING,
        providerTaskId: null
      },
      data: {
        errorCode: "PROVIDER_CREATE_OUTCOME_UNKNOWN",
        errorMessage:
          "Provider create outcome is unknown; automatic resubmission is disabled."
      }
    });
    if (marked.count !== 1) return;
    await transaction.providerSubmission.upsert({
      where: { taskId: task.id },
      create: {
        taskId: task.id,
        provider: task.provider,
        clientRequestId: task.clientRequestId,
        status: ProviderSubmissionStatus.OUTCOME_UNKNOWN,
        errorCode: "PROVIDER_CREATE_OUTCOME_UNKNOWN"
      },
      update: {
        status: ProviderSubmissionStatus.OUTCOME_UNKNOWN,
        errorCode: "PROVIDER_CREATE_OUTCOME_UNKNOWN"
      }
    });
    await transaction.taskEvent.create({
      data: {
        taskId: task.id,
        fromStatus: TaskStatus.SUBMITTING,
        toStatus: TaskStatus.SUBMITTING,
        reason: "PROVIDER_CREATE_OUTCOME_UNKNOWN"
      }
    });
  });
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
