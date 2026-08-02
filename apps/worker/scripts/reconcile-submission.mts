import { resolve } from "node:path";

import { ProviderSubmissionStatus, TaskStatus } from "@prisma/client";
import {
  hasEosAssetPublishingConfig,
  loadLocalEnvironment,
  loadWorkerConfig
} from "@seedance/config";
import { prisma } from "@seedance/db";
import {
  providerJobId,
  videoQueueName,
  type ProviderPollJob,
  type VideoGenerationJob
} from "@seedance/shared";
import {
  LocalStorage,
  S3PresignedAssetPublisher,
  type PublishedRemoteObject
} from "@seedance/storage";
import { Queue } from "bullmq";
import { Redis } from "ioredis";

loadLocalEnvironment();

const [command, ...rawArguments] = process.argv.slice(2);
const argumentsByName = parseArguments(rawArguments);
const taskId = requireIdentifier(argumentsByName.get("task-id"), "task-id");

try {
  if (command === "inspect") {
    await inspect(taskId);
  } else if (command === "bind") {
    const providerTaskId = requireIdentifier(
      argumentsByName.get("provider-task-id"),
      "provider-task-id"
    );
    await bind(taskId, providerTaskId);
  } else if (command === "not-created") {
    await confirmNotCreated(taskId);
  } else if (command === "force-cleanup") {
    const objectKey = requireObjectKey(argumentsByName.get("object-key"));
    await forceCleanup(taskId, objectKey);
  } else {
    throw new Error(
      "Usage: reconcile-submission <inspect|bind|not-created|force-cleanup> --task-id <id> [--provider-task-id <id>|--object-key <exact-key>]"
    );
  }
} finally {
  await prisma.$disconnect();
}

async function inspect(id: string): Promise<void> {
  const task = await prisma.videoTask.findUnique({
    where: { id },
    include: { submission: true, publishedAssets: true }
  });
  if (task === null) throw new Error("Task was not found.");
  console.log(
    JSON.stringify({
      taskId: task.id,
      status: task.status,
      clientRequestId: task.clientRequestId,
      providerTaskId: task.providerTaskId,
      submission: task.submission,
      publishedAssets: task.publishedAssets.map((asset) => ({
        publisher: asset.publisher,
        bucket: asset.bucket,
        objectKey: asset.objectKey,
        expiresAt: asset.expiresAt,
        deletedAt: asset.deletedAt,
        cleanupError: asset.cleanupError
      }))
    })
  );
}

async function bind(id: string, providerTaskId: string): Promise<void> {
  const config = loadWorkerConfig();
  const task = await requireReconciliationTask(id);
  await updateBridgeRegistry(task.clientRequestId, "ACCEPTED", providerTaskId);
  const now = new Date();
  const pollVersion = task.pollVersion + 1;
  await prisma.$transaction(async (transaction) => {
    const updated = await transaction.videoTask.updateMany({
      where: {
        id,
        status: {
          in: [TaskStatus.RECONCILIATION_REQUIRED, TaskStatus.SUBMITTING]
        },
        providerTaskId: null
      },
      data: {
        status: TaskStatus.PROCESSING,
        providerTaskId,
        submittedAt: now,
        pollStartedAt: now,
        nextPollAt: now,
        pollDeadlineAt: new Date(
          now.getTime() + (config.SEEDANCE_MAX_POLL_DURATION_MS ?? 600_000)
        ),
        pollVersion,
        providerAssetCleanupReadyAt: null,
        errorCode: null,
        errorMessage: null
      }
    });
    if (updated.count !== 1)
      throw new Error("Task state changed; bind aborted.");
    await transaction.providerSubmission.update({
      where: { taskId: id },
      data: {
        status: ProviderSubmissionStatus.ACCEPTED,
        providerTaskId,
        acceptedAt: now,
        reconciledAt: now,
        reconciliationNote: "REMOTE_TASK_BOUND",
        errorCode: null
      }
    });
    await transaction.taskEvent.create({
      data: {
        taskId: id,
        fromStatus: task.status,
        toStatus: TaskStatus.PROCESSING,
        reason: "MANUAL_RECONCILIATION_BOUND"
      }
    });
  });

  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new Queue<VideoGenerationJob>(videoQueueName, {
    connection: redis
  });
  try {
    const job: ProviderPollJob = {
      kind: "provider-poll",
      taskId: id,
      pollVersion
    };
    await queue.add(job.kind, job, {
      jobId: providerJobId(job),
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true
    });
  } finally {
    await queue.close();
    await redis.quit();
  }
  console.log(
    JSON.stringify({ taskId: id, providerTaskId, pollScheduled: true })
  );
}

async function confirmNotCreated(id: string): Promise<void> {
  const task = await requireReconciliationTask(id);
  await updateBridgeRegistry(task.clientRequestId, "NOT_CREATED");
  const now = new Date();
  await prisma.$transaction(async (transaction) => {
    const updated = await transaction.videoTask.updateMany({
      where: {
        id,
        status: {
          in: [TaskStatus.RECONCILIATION_REQUIRED, TaskStatus.SUBMITTING]
        },
        providerTaskId: null
      },
      data: {
        status: TaskStatus.FAILED,
        completedAt: now,
        providerAssetCleanupReadyAt: now,
        errorCode: "PROVIDER_TASK_NOT_CREATED",
        errorMessage:
          "Manual reconciliation confirmed no Provider task was created."
      }
    });
    if (updated.count !== 1) {
      throw new Error("Task state changed; confirmation aborted.");
    }
    await transaction.providerSubmission.update({
      where: { taskId: id },
      data: {
        status: ProviderSubmissionStatus.NOT_CREATED,
        reconciledAt: now,
        reconciliationNote: "CONFIRMED_NOT_CREATED"
      }
    });
    await transaction.taskEvent.create({
      data: {
        taskId: id,
        fromStatus: task.status,
        toStatus: TaskStatus.FAILED,
        reason: "MANUAL_RECONCILIATION_NOT_CREATED"
      }
    });
  });
  const cleaned = await cleanupTaskObjects(id);
  console.log(JSON.stringify({ taskId: id, notCreated: true, cleaned }));
}

async function forceCleanup(id: string, exactObjectKey: string): Promise<void> {
  const record = await prisma.publishedProviderAsset.findFirst({
    where: { taskId: id, objectKey: exactObjectKey, deletedAt: null }
  });
  if (record === null)
    throw new Error("Active published object was not found.");
  const cleaned = await cleanupTaskObjects(id, exactObjectKey);
  console.log(JSON.stringify({ taskId: id, forceCleanup: true, cleaned }));
}

async function cleanupTaskObjects(
  id: string,
  exactObjectKey?: string
): Promise<number> {
  const records = await prisma.publishedProviderAsset.findMany({
    where: {
      taskId: id,
      deletedAt: null,
      ...(exactObjectKey === undefined ? {} : { objectKey: exactObjectKey })
    }
  });
  if (records.length === 0) return 0;
  const publisher = createEosPublisher();
  let cleaned = 0;
  for (const record of records) {
    const remoteObject: PublishedRemoteObject = {
      publisher: "eos",
      bucket: record.bucket,
      objectKey: record.objectKey
    };
    try {
      await publisher.deletePublishedAsset(remoteObject);
      await prisma.publishedProviderAsset.update({
        where: { id: record.id },
        data: { deletedAt: new Date(), cleanupError: null }
      });
      cleaned += 1;
    } catch {
      await prisma.publishedProviderAsset.update({
        where: { id: record.id },
        data: { cleanupError: "EOS_DELETE_FAILED" }
      });
      throw new Error("EOS cleanup failed; task state was preserved.");
    }
  }
  return cleaned;
}

function createEosPublisher(): S3PresignedAssetPublisher {
  const config = loadWorkerConfig();
  if (!hasEosAssetPublishingConfig(config)) {
    throw new Error("EOS asset publishing is not configured.");
  }
  const storage = new LocalStorage(resolve(process.cwd(), config.STORAGE_ROOT));
  return new S3PresignedAssetPublisher({
    endpoint: config.EOS_ENDPOINT,
    region: config.EOS_REGION,
    bucket: config.EOS_BUCKET,
    accessKeyId: config.EOS_ACCESS_KEY_ID,
    secretAccessKey: config.EOS_SECRET_ACCESS_KEY,
    objectPrefix: config.EOS_OBJECT_PREFIX,
    presignTtlSeconds: config.EOS_PRESIGN_TTL_SECONDS,
    forcePathStyle: config.EOS_FORCE_PATH_STYLE,
    maxBytes: config.SEEDANCE_ASSET_MAX_BYTES,
    videoMaxBytes: config.APP_VIDEO_MAX_BYTES,
    videoInspectionPolicy: {
      minDurationSeconds: 2,
      maxDurationSeconds: 15,
      ffprobePath: config.FFPROBE_PATH
    },
    storage,
    loadAsset: async (assetId) => {
      const asset = await prisma.asset.findUnique({ where: { id: assetId } });
      return asset === null
        ? null
        : {
            id: asset.id,
            kind: asset.kind,
            storageKey: asset.storageKey,
            mimeType: asset.mimeType,
            sizeBytes: Number(asset.sizeBytes),
            checksum: asset.checksum,
            durationMs: asset.durationMs,
            width: asset.width,
            height: asset.height,
            codec: asset.codec,
            pixelFormat: asset.pixelFormat,
            frameRate: asset.frameRate,
            hasAudio: asset.hasAudio
          };
    }
  });
}

async function requireReconciliationTask(id: string) {
  const task = await prisma.videoTask.findUnique({ where: { id } });
  if (
    task === null ||
    (task.status !== TaskStatus.RECONCILIATION_REQUIRED &&
      task.status !== TaskStatus.SUBMITTING) ||
    task.providerTaskId !== null
  ) {
    throw new Error("Task is not awaiting create reconciliation.");
  }
  return task;
}

async function updateBridgeRegistry(
  clientRequestId: string,
  outcome: "ACCEPTED" | "NOT_CREATED",
  providerTaskId?: string
): Promise<void> {
  const config = loadWorkerConfig();
  const response = await fetch(
    `${requireValue(config.SEEDANCE_BRIDGE_URL, "SEEDANCE_BRIDGE_URL").replace(/\/$/, "")}/v1/video/submissions/reconcile`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requireValue(config.SEEDANCE_BRIDGE_TOKEN, "SEEDANCE_BRIDGE_TOKEN")}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        clientRequestId,
        outcome,
        ...(providerTaskId === undefined ? {} : { providerTaskId })
      })
    }
  );
  if (!response.ok) throw new Error("Bridge reconciliation update failed.");
}

function parseArguments(values: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (name === undefined || value === undefined || !name.startsWith("--")) {
      throw new Error("Invalid command arguments.");
    }
    result.set(name.slice(2), value);
  }
  return result;
}

function requireIdentifier(value: string | undefined, name: string): string {
  if (value === undefined || !/^[A-Za-z0-9._:-]{1,256}$/.test(value)) {
    throw new Error(`Invalid --${name}.`);
  }
  return value;
}

function requireObjectKey(value: string | undefined): string {
  if (
    value === undefined ||
    !/^seedance-inputs\/(?:videos\/)?[a-f0-9]{64}$/.test(value)
  ) {
    throw new Error("Invalid --object-key.");
  }
  return value;
}

function requireValue(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing ${name}.`);
  }
  return value;
}
