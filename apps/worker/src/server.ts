import Fastify, { type FastifyInstance } from "fastify";

export interface WorkerHealth {
  redis: "up" | "down";
}

export function buildWorkerServer(
  getHealth: () => WorkerHealth
): FastifyInstance {
  const server = Fastify({ logger: true });
  server.get("/health", async () => {
    const health = getHealth();
    return {
      status: health.redis === "up" ? "ok" : "degraded",
      checkedAt: new Date().toISOString(),
      services: {
        worker: { status: "up" },
        redis: { status: health.redis },
        provider: { status: "up", name: "mock" }
      }
    };
  });
  return server;
}
