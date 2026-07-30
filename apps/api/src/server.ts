import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";

import type { HealthResponse } from "@seedance/shared";

export interface ServerOptions {
  webOrigin: string;
  checkHealth(): Promise<HealthResponse>;
}

export async function buildServer(
  options: ServerOptions
): Promise<FastifyInstance> {
  const server = Fastify({ logger: true });

  await server.register(cors, {
    origin: options.webOrigin,
    methods: ["GET", "POST"]
  });

  server.get("/health", async (_request, reply) => {
    const health = await options.checkHealth();
    return reply.code(health.status === "ok" ? 200 : 503).send(health);
  });

  return server;
}
