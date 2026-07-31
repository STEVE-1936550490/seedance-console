import { resolve } from "node:path";

import { loadApiConfig, loadLocalEnvironment } from "@seedance/config";
import { prisma } from "@seedance/db";
import { createProviderDefinition } from "@seedance/seedance-provider";
import { videoQueueName, type VideoGenerationJob } from "@seedance/shared";
import { LocalStorage } from "@seedance/storage";
import { Queue } from "bullmq";
import { Redis } from "ioredis";

import { createHealthChecker, createRedisHeartbeatReader } from "./health.js";
import { registerMvpRoutes } from "./mvp-routes.js";
import { buildServer } from "./server.js";

loadLocalEnvironment();
const config = loadApiConfig();

const checkHealth = createHealthChecker({
  checkPostgres: async () => {
    await prisma.$queryRaw`SELECT 1`;
  },
  getWorkerHeartbeat: createRedisHeartbeatReader(
    config.REDIS_URL,
    config.WORKER_HEARTBEAT_KEY
  )
});

const server = await buildServer({
  webOrigin: config.WEB_ORIGIN,
  checkHealth
});

const queueConnection = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: null
});
queueConnection.on("error", () => undefined);
const taskQueue = new Queue<VideoGenerationJob>(videoQueueName, {
  connection: queueConnection
});
const provider =
  config.SEEDANCE_PROVIDER === "mock"
    ? createProviderDefinition({ provider: "mock" })
    : createProviderDefinition({
        provider: "seedance",
        modelId: requireSeedanceModelId(config.SEEDANCE_MODEL_ID)
      });
const storage = new LocalStorage(resolve(process.cwd(), config.STORAGE_ROOT));

await registerMvpRoutes(server, {
  prisma,
  provider,
  taskQueue,
  storage,
  uploadMaxBytes: config.UPLOAD_MAX_BYTES
});

const close = async (): Promise<void> => {
  await taskQueue.close();
  queueConnection.disconnect();
  await server.close();
  await prisma.$disconnect();
};

process.once("SIGINT", () => {
  void close().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void close().finally(() => process.exit(0));
});

await server.listen({ host: config.API_HOST, port: config.API_PORT });

function requireSeedanceModelId(value: string | undefined): string {
  if (value === undefined) {
    throw new Error(
      "SEEDANCE_MODEL_ID is required when SEEDANCE_PROVIDER=seedance."
    );
  }
  return value;
}
