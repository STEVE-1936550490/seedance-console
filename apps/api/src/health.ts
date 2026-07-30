import { Redis } from "ioredis";

import type { HealthResponse, ServiceHealth } from "@seedance/shared";

export interface HealthDependencies {
  checkPostgres(): Promise<void>;
  getWorkerHeartbeat(): Promise<string | null>;
}

export function createHealthChecker(
  dependencies: HealthDependencies
): () => Promise<HealthResponse> {
  return async () => {
    const [postgres, workerHeartbeat] = await Promise.all([
      checkService(() => dependencies.checkPostgres()),
      getHeartbeat(dependencies)
    ]);

    const worker: ServiceHealth =
      workerHeartbeat.value === null
        ? {
            status: "down",
            message: workerHeartbeat.message ?? "No heartbeat."
          }
        : { status: "up" };

    const redis: ServiceHealth = workerHeartbeat.redisAvailable
      ? { status: "up" }
      : {
          status: "down",
          message: workerHeartbeat.message ?? "Redis is unavailable."
        };

    const status =
      postgres.status === "up" &&
      redis.status === "up" &&
      worker.status === "up"
        ? "ok"
        : "degraded";

    return {
      status,
      checkedAt: new Date().toISOString(),
      services: {
        api: { status: "up" },
        worker,
        postgres,
        redis
      }
    };
  };
}

export function createRedisHeartbeatReader(
  redisUrl: string,
  heartbeatKey: string
): () => Promise<string | null> {
  return async () => {
    const redis = new Redis(redisUrl, {
      lazyConnect: true,
      connectTimeout: 1_000,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null
    });
    redis.on("error", () => undefined);
    try {
      await redis.connect();
      return await redis.get(heartbeatKey);
    } finally {
      redis.disconnect();
    }
  };
}

async function checkService(
  operation: () => Promise<void>
): Promise<ServiceHealth> {
  try {
    await operation();
    return { status: "up" };
  } catch {
    return { status: "down", message: "Connection check failed." };
  }
}

async function getHeartbeat(dependencies: HealthDependencies): Promise<{
  value: string | null;
  redisAvailable: boolean;
  message?: string;
}> {
  try {
    const value = await dependencies.getWorkerHeartbeat();
    return value === null
      ? { value, redisAvailable: true, message: "No active Worker heartbeat." }
      : { value, redisAvailable: true };
  } catch {
    return {
      value: null,
      redisAvailable: false,
      message: "Redis connection check failed."
    };
  }
}
