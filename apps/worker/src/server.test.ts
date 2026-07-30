import { afterEach, describe, expect, it } from "vitest";

import type { FastifyInstance } from "fastify";

import { buildWorkerServer } from "./server.js";

describe("Worker GET /health", () => {
  let server: FastifyInstance | undefined;

  afterEach(async () => {
    await server?.close();
  });

  it("reports the Mock Provider and Redis status", async () => {
    server = buildWorkerServer(() => ({ redis: "up" }));
    const response = await server.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      services: {
        worker: { status: "up" },
        redis: { status: "up" },
        provider: { status: "up", name: "mock" }
      }
    });
  });
});
