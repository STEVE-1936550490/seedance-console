import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import type { PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  MockSeedanceProvider,
  SeedanceProviderAdapter,
  type BridgeCreateVideoTaskRequest
} from "@seedance/seedance-provider";
import type { VideoGenerationJob } from "@seedance/shared";
import {
  LocalStorage,
  SignedAssetPublisher,
  type PublishableAssetRecord
} from "@seedance/storage";
import { registerMvpRoutes } from "./mvp-routes.js";

describe("reference-video fixture Bridge E2E", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots
        .splice(0)
        .map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  it("validates, publishes, serves, and maps one MP4 reference video", async () => {
    const root = await mkdtemp(join(tmpdir(), "seedance-video-e2e-"));
    temporaryRoots.push(root);
    const storage = new LocalStorage(root);
    const video = await readFile(
      new URL(
        "../../../packages/seedance-provider/fixtures/mock-output.mp4",
        import.meta.url
      )
    );
    await storage.put("inputs/videos/reference.mp4", Readable.from(video));
    const record: PublishableAssetRecord = {
      id: "asset-reference-video",
      kind: "INPUT_VIDEO",
      storageKey: "inputs/videos/reference.mp4",
      mimeType: "video/mp4",
      sizeBytes: video.byteLength,
      checksum: createHash("sha256").update(video).digest("hex"),
      durationMs: 3_000,
      width: 1280,
      height: 720,
      codec: "h264",
      pixelFormat: "yuv420p",
      frameRate: "24/1",
      hasAudio: false
    };
    const publisher = new SignedAssetPublisher({
      signingKey: "fixture-e2e-signing-key-at-least-32-bytes",
      publicBaseUrl: "https://assets.example.com",
      urlTtlMs: 120_000,
      maxBytes: 20_000,
      videoMaxBytes: 20_000,
      videoInspectionPolicy: {
        minDurationSeconds: 2,
        maxDurationSeconds: 15
      },
      storage,
      loadAsset: async (assetId) => (assetId === record.id ? record : null)
    });
    const server = Fastify({ logger: false });
    await registerMvpRoutes(server, {
      prisma: {} as PrismaClient,
      provider: new MockSeedanceProvider(),
      taskQueue: {} as Queue<VideoGenerationJob>,
      storage,
      uploadMaxBytes: 20_000,
      appVideoMaxBytes: 20_000,
      assetPublisher: publisher
    });

    const published = await publisher.publishForProvider({
      assetId: record.id,
      provider: "seedance",
      purpose: "reference-video",
      minimumTtlMs: 60_000
    });
    let captured: BridgeCreateVideoTaskRequest | undefined;
    const adapter = new SeedanceProviderAdapter({
      modelId: "fixture-model",
      bridgeClient: {
        createTask: async (request) => {
          captured = request;
          const content = request.request.content[1];
          expect(content?.type).toBe("video_url");
          if (content?.type !== "video_url") throw new Error("video missing");
          const url = new URL(content.video_url.url);
          const fetched = await server.inject({
            method: "GET",
            url: `${url.pathname}${url.search}`
          });
          expect(fetched.statusCode).toBe(200);
          expect(fetched.headers["content-type"]).toContain("video/mp4");
          expect(fetched.rawPayload).toEqual(video);
          return { id: "fixture-provider-task-not-sent" };
        },
        recoverTask: async () => null,
        getTask: async () => ({ status: "running" }),
        downloadOutput: async () => {
          throw new Error("No output exists in this create-only fixture.");
        }
      }
    });

    await adapter.createTask({
      clientRequestId: "fixture-reference-video",
      model: "fixture-model",
      prompt: "全程参考视频1的主体与运镜。",
      referenceAssetIds: [record.id],
      publishedAssets: [{ ...published, position: 0 }],
      parameters: {
        ratio: "16:9",
        duration: 11,
        generateAudio: false,
        watermark: false
      }
    });
    expect(captured?.request.content[1]).toEqual({
      type: "video_url",
      video_url: { url: published.url },
      role: "reference_video"
    });
    await server.close();
  });
});
