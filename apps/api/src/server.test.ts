import { afterEach, describe, expect, it } from "vitest";

import type { FastifyInstance } from "fastify";

import { buildServer } from "./server.js";

describe("GET /health", () => {
  let server: FastifyInstance | undefined;

  afterEach(async () => {
    await server?.close();
  });

  it("returns the normalized service health", async () => {
    server = await buildServer({
      webOrigin: "http://localhost:43170",
      checkHealth: async () => ({
        status: "ok",
        checkedAt: "2026-07-30T00:00:00.000Z",
        services: {
          api: { status: "up" },
          worker: { status: "up" },
          postgres: { status: "up" },
          redis: { status: "up" }
        }
      })
    });

    const response = await server.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      services: { api: { status: "up" }, worker: { status: "up" } }
    });
  });

  it("returns 503 when a dependency is degraded", async () => {
    server = await buildServer({
      webOrigin: "http://localhost:43170",
      checkHealth: async () => ({
        status: "degraded",
        checkedAt: "2026-07-30T00:00:00.000Z",
        services: {
          api: { status: "up" },
          worker: { status: "down" },
          postgres: { status: "up" },
          redis: { status: "up" }
        }
      })
    });

    const response = await server.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: "degraded" });
  });
});
