import type { PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  MockSeedanceProvider,
  openMockVideoFixture
} from "@seedance/seedance-provider";
import type { VideoGenerationJob } from "@seedance/shared";
import type { Storage } from "@seedance/storage";

import { registerMvpRoutes } from "./mvp-routes.js";
import { buildServer } from "./server.js";

describe("MVP media and capabilities routes", () => {
  let server: FastifyInstance | undefined;

  afterEach(async () => {
    await server?.close();
  });

  it("serves Provider capabilities and a playable Mock video", async () => {
    server = await buildServer({
      webOrigin: "http://localhost:43170",
      checkHealth: async () => ({
        status: "ok",
        checkedAt: new Date().toISOString(),
        services: {
          api: { status: "up" },
          worker: { status: "up" },
          postgres: { status: "up" },
          redis: { status: "up" }
        }
      })
    });

    const prisma = {
      taskAsset: {
        findFirst: async () => ({
          asset: {
            storageKey: "outputs/task-1.mp4",
            mimeType: "video/mp4",
            sizeBytes: BigInt(12_000)
          }
        })
      }
    } as unknown as PrismaClient;
    const storage: Storage = {
      put: async () => ({ sizeBytes: 0 }),
      putAtomic: async () => ({ sizeBytes: 0, sha256: "0".repeat(64) }),
      inspect: async () => ({
        sizeBytes: 12_000,
        sha256: "0".repeat(64)
      }),
      openReadStream: () => openMockVideoFixture(),
      stat: async () => ({ sizeBytes: 12_000 }),
      delete: async () => undefined
    };

    await registerMvpRoutes(server, {
      prisma,
      storage,
      provider: new MockSeedanceProvider(),
      taskQueue: {} as Queue<VideoGenerationJob>,
      uploadMaxBytes: 10 * 1024 * 1024
    });

    const capabilities = await server.inject({
      method: "GET",
      url: "/api/providers/capabilities"
    });
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json()).toMatchObject({
      provider: "mock",
      models: [{ id: "mock-video-v1" }]
    });

    const video = await server.inject({
      method: "GET",
      url: "/api/tasks/task-1/video"
    });
    expect(video.statusCode).toBe(200);
    expect(video.headers["content-type"]).toContain("video/mp4");
    expect(video.rawPayload.byteLength).toBeGreaterThan(1_000);
  });
});
