import { resolve } from "node:path";

import { loadLocalEnvironment, loadWorkerConfig } from "@seedance/config";
import { prisma } from "@seedance/db";
import { MockSeedanceProvider } from "@seedance/seedance-provider";
import {
  parseVideoGenerationJob,
  videoQueueName,
  type VideoGenerationJob
} from "@seedance/shared";
import { LocalStorage } from "@seedance/storage";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";

import { buildWorkerServer, type WorkerHealth } from "./server.js";
import { createDownloadProcessor } from "./download-processor.js";
import { BullMqProviderJobScheduler } from "./job-scheduler.js";
import { createPollCoordinator } from "./poll-coordinator.js";
import { PrismaTaskStore } from "./task-store.js";
import {
  createPollProcessor,
  createSubmitProcessor
} from "./task-processor.js";

loadLocalEnvironment();
const config = loadWorkerConfig();
if (config.SEEDANCE_PROVIDER !== "mock") {
  throw new Error(
    "Real Seedance runtime remains disabled until the private Bridge and asset publishing flow are implemented."
  );
}
const provider = new MockSeedanceProvider();
const storage = new LocalStorage(resolve(process.cwd(), config.STORAGE_ROOT));

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
  policy
});
const processPoll = createPollProcessor({
  store,
  provider,
  scheduler,
  policy
});
const processDownload = createDownloadProcessor({
  store,
  provider,
  storage,
  scheduler,
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
void reconcilePolls().catch(() => undefined);
const reconcileTimer = setInterval(
  () => void reconcilePolls().catch(() => undefined),
  config.WORKER_RECONCILE_INTERVAL_MS
);
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
