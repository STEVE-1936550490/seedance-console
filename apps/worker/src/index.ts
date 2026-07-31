import { resolve } from "node:path";

import { loadLocalEnvironment, loadWorkerConfig } from "@seedance/config";
import { prisma } from "@seedance/db";
import { MockSeedanceProvider } from "@seedance/seedance-provider";
import { videoQueueName, type VideoGenerationJob } from "@seedance/shared";
import { LocalStorage } from "@seedance/storage";
import { Worker } from "bullmq";
import { Redis } from "ioredis";

import { buildWorkerServer, type WorkerHealth } from "./server.js";
import { createTaskProcessor } from "./task-processor.js";

loadLocalEnvironment();
const config = loadWorkerConfig();
if (config.SEEDANCE_PROVIDER !== "mock") {
  throw new Error(
    "Real Seedance runtime remains disabled until the private Bridge and asset publishing flow are implemented."
  );
}
const provider = new MockSeedanceProvider();
const storage = new LocalStorage(resolve(process.cwd(), config.STORAGE_ROOT));
const processTask = createTaskProcessor({ prisma, provider, storage });

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

const queueWorker = new Worker<VideoGenerationJob>(
  videoQueueName,
  async (job) => processTask(job.data.taskId),
  {
    connection: redis,
    concurrency: 2
  }
);
queueWorker.on("error", () => {
  health.redis = "down";
});

const server = buildWorkerServer(() => health);

const close = async (): Promise<void> => {
  clearInterval(heartbeatTimer);
  await queueWorker.close();
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
