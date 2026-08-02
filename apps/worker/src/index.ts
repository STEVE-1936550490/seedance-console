import { resolve } from "node:path";

import {
  hasAssetPublishingConfig,
  hasEosAssetPublishingConfig,
  loadLocalEnvironment,
  loadWorkerConfig
} from "@seedance/config";
import { prisma } from "@seedance/db";
import {
  createProviderRuntime,
  SeedanceBridgeClient
} from "@seedance/seedance-provider";
import {
  parseVideoGenerationJob,
  videoQueueName,
  type VideoGenerationJob
} from "@seedance/shared";
import {
  LocalStorage,
  S3PresignedAssetPublisher,
  SignedAssetPublisher
} from "@seedance/storage";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";

import { buildWorkerServer, type WorkerHealth } from "./server.js";
import { createDownloadProcessor } from "./download-processor.js";
import { BullMqProviderJobScheduler } from "./job-scheduler.js";
import { createPollCoordinator } from "./poll-coordinator.js";
import { PrismaTaskStore } from "./task-store.js";
import {
  createPollProcessor,
  createSubmitProcessor,
  cleanupTerminalPublishedAssets
} from "./task-processor.js";

loadLocalEnvironment();
const config = loadWorkerConfig();
const provider =
  config.SEEDANCE_PROVIDER === "mock"
    ? createProviderRuntime({ provider: "mock" })
    : createProviderRuntime({
        provider: "seedance",
        modelId: requireConfig(config.SEEDANCE_MODEL_ID, "SEEDANCE_MODEL_ID"),
        bridgeClient: new SeedanceBridgeClient({
          baseUrl: requireConfig(
            config.SEEDANCE_BRIDGE_URL,
            "SEEDANCE_BRIDGE_URL"
          ),
          token: requireConfig(
            config.SEEDANCE_BRIDGE_TOKEN,
            "SEEDANCE_BRIDGE_TOKEN"
          ),
          requestTimeoutMs: requireConfig(
            config.SEEDANCE_REQUEST_TIMEOUT_MS,
            "SEEDANCE_REQUEST_TIMEOUT_MS"
          ),
          downloadTimeoutMs: requireConfig(
            config.SEEDANCE_DOWNLOAD_TIMEOUT_MS,
            "SEEDANCE_DOWNLOAD_TIMEOUT_MS"
          )
        })
      });
const storage = new LocalStorage(resolve(process.cwd(), config.STORAGE_ROOT));
const loadAsset = async (assetId: string) => {
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
};
const assetPublisher =
  config.SEEDANCE_PROVIDER !== "seedance"
    ? undefined
    : hasEosAssetPublishingConfig(config)
      ? new S3PresignedAssetPublisher({
          endpoint: config.EOS_ENDPOINT,
          region: config.EOS_REGION,
          bucket: config.EOS_BUCKET,
          accessKeyId: config.EOS_ACCESS_KEY_ID,
          secretAccessKey: config.EOS_SECRET_ACCESS_KEY,
          objectPrefix: config.EOS_OBJECT_PREFIX,
          presignTtlSeconds: config.EOS_PRESIGN_TTL_SECONDS,
          forcePathStyle: config.EOS_FORCE_PATH_STYLE,
          verifyPresignedGet: true,
          maxBytes: config.SEEDANCE_ASSET_MAX_BYTES,
          videoMaxBytes: config.APP_VIDEO_MAX_BYTES,
          videoInspectionPolicy: {
            minDurationSeconds: 2,
            maxDurationSeconds: 15,
            ffprobePath: config.FFPROBE_PATH
          },
          storage,
          loadAsset
        })
      : hasAssetPublishingConfig(config)
        ? new SignedAssetPublisher({
            signingKey: config.SEEDANCE_ASSET_SIGNING_KEY,
            publicBaseUrl: config.SEEDANCE_ASSET_PUBLIC_BASE_URL,
            urlTtlMs: config.SEEDANCE_ASSET_URL_TTL_MS,
            maxBytes: config.SEEDANCE_ASSET_MAX_BYTES,
            videoMaxBytes: config.APP_VIDEO_MAX_BYTES,
            videoInspectionPolicy: {
              minDurationSeconds: 2,
              maxDurationSeconds: 15,
              ffprobePath: config.FFPROBE_PATH
            },
            storage,
            loadAsset
          })
        : undefined;

const health: WorkerHealth = { redis: "down" };
const redis = new Redis(config.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: null,
  retryStrategy: (attempt) => Math.min(attempt * 500, 5_000)
});
redis.on("ready", () => {
  health.redis = "up";
});
redis.on("close", () => {
  health.redis = "down";
});
redis.on("error", () => {
  health.redis = "down";
});

async function heartbeat(): Promise<void> {
  try {
    await redis.set(
      config.WORKER_HEARTBEAT_KEY,
      new Date().toISOString(),
      "EX",
      config.WORKER_HEARTBEAT_TTL_SECONDS
    );
    health.redis = "up";
  } catch {
    health.redis = "down";
  }
}

void redis.connect().catch(() => undefined);
void heartbeat();
const heartbeatTimer = setInterval(
  () => void heartbeat(),
  Math.floor((config.WORKER_HEARTBEAT_TTL_SECONDS * 1_000) / 3)
);
heartbeatTimer.unref();

const taskQueue = new Queue<VideoGenerationJob>(videoQueueName, {
  connection: redis
});
const scheduler = new BullMqProviderJobScheduler(taskQueue);
const store = new PrismaTaskStore(prisma);
const policy = {
  baseIntervalMs: config.SEEDANCE_POLL_INTERVAL_MS ?? 1_500,
  maxIntervalMs: config.SEEDANCE_MAX_POLL_INTERVAL_MS ?? 30_000,
  maxDurationMs: config.SEEDANCE_MAX_POLL_DURATION_MS ?? 10 * 60_000,
  requestTimeoutMs: config.SEEDANCE_REQUEST_TIMEOUT_MS ?? 30_000,
  jitterRatio: config.SEEDANCE_POLL_JITTER_RATIO,
  downloadMaxDurationMs: config.SEEDANCE_MAX_DOWNLOAD_DURATION_MS
};
const processSubmit = createSubmitProcessor({
  store,
  provider,
  scheduler,
  policy,
  assetUrlMinimumTtlMs: policy.requestTimeoutMs + 60_000,
  deletePublishedAssetsOnTerminal: config.EOS_DELETE_ON_TERMINAL,
  ...(assetPublisher === undefined ? {} : { assetPublisher })
});
const processPoll = createPollProcessor({
  store,
  provider,
  scheduler,
  policy,
  deletePublishedAssetsOnTerminal: config.EOS_DELETE_ON_TERMINAL,
  ...(assetPublisher === undefined ? {} : { assetPublisher })
});
const processDownload = createDownloadProcessor({
  store,
  provider,
  storage,
  scheduler,
  deletePublishedAssetsOnTerminal: config.EOS_DELETE_ON_TERMINAL,
  ...(assetPublisher === undefined ? {} : { assetPublisher }),
  policy: {
    maxBytes: config.SEEDANCE_DOWNLOAD_MAX_BYTES,
    timeoutMs: config.SEEDANCE_DOWNLOAD_TIMEOUT_MS ?? 60_000,
    baseRetryIntervalMs: config.SEEDANCE_DOWNLOAD_RETRY_INTERVAL_MS,
    maxRetryIntervalMs: config.SEEDANCE_DOWNLOAD_MAX_RETRY_INTERVAL_MS,
    maxAttempts: config.SEEDANCE_DOWNLOAD_MAX_ATTEMPTS,
    jitterRatio: config.SEEDANCE_POLL_JITTER_RATIO
  }
});
const queueWorker = new Worker<VideoGenerationJob>(
  videoQueueName,
  async (job) => {
    const payload = parseVideoGenerationJob(job.data);
    switch (payload.kind) {
      case "provider-submit":
        await processSubmit(payload.taskId);
        return;
      case "provider-poll":
        await processPoll(payload.taskId, payload.pollVersion);
        return;
      case "provider-download":
        await processDownload(
          payload.taskId,
          payload.providerTaskId,
          payload.downloadVersion
        );
    }
  },
  {
    connection: redis,
    concurrency: 2
  }
);
queueWorker.on("error", () => {
  health.redis = "down";
});

const reconcilePolls = createPollCoordinator({
  store,
  scheduler,
  batchSize: config.WORKER_RECONCILE_BATCH_SIZE
});
const cleanupTerminalAssets = () =>
  cleanupTerminalPublishedAssets(
    {
      store,
      deletePublishedAssetsOnTerminal: config.EOS_DELETE_ON_TERMINAL,
      ...(assetPublisher === undefined ? {} : { assetPublisher })
    },
    config.WORKER_RECONCILE_BATCH_SIZE
  );
void reconcilePolls().catch(() => undefined);
void cleanupTerminalAssets().catch(() => undefined);
const reconcileTimer = setInterval(() => {
  void reconcilePolls().catch(() => undefined);
  void cleanupTerminalAssets().catch(() => undefined);
}, config.WORKER_RECONCILE_INTERVAL_MS);
reconcileTimer.unref();

const server = buildWorkerServer(() => health);

const close = async (): Promise<void> => {
  clearInterval(heartbeatTimer);
  clearInterval(reconcileTimer);
  await queueWorker.close();
  await taskQueue.close();
  redis.disconnect();
  await server.close();
  await prisma.$disconnect();
};

process.once("SIGINT", () => {
  void close().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void close().finally(() => process.exit(0));
});

await server.listen({ host: config.WORKER_HOST, port: config.WORKER_PORT });

function requireConfig<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`${name} is required for the Seedance runtime.`);
  }
  return value;
}
