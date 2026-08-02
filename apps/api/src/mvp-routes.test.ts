import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import type { PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MockSeedanceProvider,
  SeedanceProviderDefinition,
  openMockVideoFixture
} from "@seedance/seedance-provider";
import type { VideoGenerationJob } from "@seedance/shared";
import {
  LocalStorage,
  SignedAssetPublisher,
  type PublishableAssetRecord,
  type Storage
} from "@seedance/storage";

import { registerMvpRoutes } from "./mvp-routes.js";
import { buildServer } from "./server.js";

describe("MVP media and capabilities routes", () => {
  let server: FastifyInstance | undefined;
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await server?.close();
    server = undefined;
    await Promise.all(
      temporaryRoots
        .splice(0)
        .map((root) => rm(root, { recursive: true, force: true }))
    );
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

  it("serves only a valid signed Provider image URL without logging its token", async () => {
    let logs = "";
    server = Fastify({
      logger: {
        level: "info",
        stream: new Writable({
          write(chunk, _encoding, callback) {
            logs += chunk.toString();
            callback();
          }
        })
      }
    });
    const root = await mkdtemp(join(tmpdir(), "seedance-api-assets-"));
    temporaryRoots.push(root);
    const storage = new LocalStorage(root);
    const image = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.from("api-fixture")
    ]);
    await storage.put("inputs/reference.png", Readable.from(image));
    const record: PublishableAssetRecord = {
      id: "asset-one",
      kind: "INPUT_IMAGE",
      storageKey: "inputs/reference.png",
      mimeType: "image/png",
      sizeBytes: image.byteLength,
      checksum: createHash("sha256").update(image).digest("hex")
    };
    let currentTime = Date.parse("2026-07-31T12:00:00.000Z");
    const publisher = new SignedAssetPublisher({
      signingKey: "api-fixture-signing-key-with-32-bytes",
      publicBaseUrl: "https://assets.example.com",
      urlTtlMs: 60_000,
      maxBytes: 1_024,
      storage,
      loadAsset: async (assetId) => (assetId === record.id ? record : null),
      now: () => new Date(currentTime)
    });
    await registerMvpRoutes(server, {
      prisma: {} as PrismaClient,
      storage,
      provider: new MockSeedanceProvider(),
      taskQueue: {} as Queue<VideoGenerationJob>,
      uploadMaxBytes: 1_024,
      assetPublisher: publisher
    });
    const published = await publisher.publishForProvider({
      assetId: record.id,
      provider: "seedance",
      purpose: "reference-image",
      minimumTtlMs: 1
    });
    const signedUrl = new URL(published.url);
    const requestUrl = `${signedUrl.pathname}${signedUrl.search}`;

    const response = await server.inject({ method: "GET", url: requestUrl });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(image);
    expect(response.headers).toMatchObject({
      "content-type": "image/png",
      "content-length": String(image.byteLength),
      etag: `"${record.checksum}"`,
      "cache-control": "private, no-store"
    });
    const head = await server.inject({ method: "HEAD", url: requestUrl });
    expect(head.statusCode).toBe(200);
    expect(head.rawPayload).toHaveLength(0);
    const wrongMethod = await server.inject({
      method: "POST",
      url: requestUrl
    });
    expect(wrongMethod.statusCode).toBe(405);

    currentTime += 60_001;
    const expired = await server.inject({ method: "GET", url: requestUrl });
    expect(expired.statusCode).toBe(403);
    expect(expired.json()).toEqual({ error: "ASSET_URL_EXPIRED" });

    signedUrl.searchParams.set("signature", "short");
    const tampered = await server.inject({
      method: "GET",
      url: `${signedUrl.pathname}${signedUrl.search}`
    });
    expect(tampered.statusCode).toBe(403);
    expect(logs).not.toContain("signature=");
    expect(logs).not.toContain(published.url);
  });

  it("uploads a valid MP4 and rejects extension spoofing or damaged bytes", async () => {
    server = Fastify({ logger: false });
    const root = await mkdtemp(join(tmpdir(), "seedance-api-video-"));
    temporaryRoots.push(root);
    const storage = new LocalStorage(root);
    const video = await readFile(
      new URL(
        "../../../packages/seedance-provider/fixtures/mock-output.mp4",
        import.meta.url
      )
    );
    const created: unknown[] = [];
    const prisma = {
      asset: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return { id: "video-asset", ...data };
        }
      }
    } as unknown as PrismaClient;
    await registerMvpRoutes(server, {
      prisma,
      storage,
      provider: new MockSeedanceProvider(),
      taskQueue: {} as Queue<VideoGenerationJob>,
      uploadMaxBytes: 20 * 1024 * 1024,
      appVideoMaxBytes: 20 * 1024 * 1024
    });

    const valid = await server.inject(
      multipartRequest("reference.mp4", "video/mp4", video)
    );
    expect(valid.statusCode).toBe(201);
    expect(valid.json()).toMatchObject({
      kind: "video",
      mimeType: "video/mp4",
      durationSeconds: 3,
      width: 1280,
      height: 720,
      codec: "h264",
      frameRate: "24/1",
      hasAudio: false
    });
    expect(created).toHaveLength(1);

    const disguised = await server.inject(
      multipartRequest("reference.jpg", "video/mp4", video)
    );
    expect(disguised.statusCode).toBe(415);
    expect(disguised.json()).toEqual({ error: "VIDEO_EXTENSION_MISMATCH" });

    const damaged = await server.inject(
      multipartRequest("broken.mp4", "video/mp4", Buffer.from("not-an-mp4"))
    );
    expect(damaged.statusCode).toBe(422);
    expect(damaged.json()).toEqual({ error: "VIDEO_FILE_INVALID" });
  });

  it("creates a Seedance task with one MP4 mapped to REFERENCE_VIDEO", async () => {
    server = Fastify({ logger: false });
    const now = new Date("2026-08-02T12:00:00.000Z");
    const videoAsset = {
      id: "video-asset",
      kind: "INPUT_VIDEO",
      storageKey: "inputs/videos/private.mp4",
      originalName: "reference.mp4",
      mimeType: "video/mp4",
      sizeBytes: BigInt(7_309_809),
      checksum:
        "6ea9470b628cf49913b647f7431fa86594bef2f3719482ea25e7f16ddce1f7eb",
      durationMs: 11_042,
      width: 1280,
      height: 720,
      codec: "h264",
      pixelFormat: "yuv420p",
      frameRate: "24/1",
      hasAudio: false,
      createdAt: now
    };
    let taskCreateData: Record<string, unknown> | undefined;
    const task = {
      id: "task-video",
      clientRequestId: "reference-video-request",
      provider: "seedance",
      providerTaskId: null,
      model: "doubao-seedance-2.0",
      status: "QUEUED",
      prompt: "全程参考视频1的主体与运镜。",
      parameters: {
        ratio: "16:9",
        duration: 11,
        generateAudio: false,
        watermark: false
      },
      errorCode: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
      submittedAt: null,
      completedAt: null,
      assets: [
        {
          role: "REFERENCE_VIDEO",
          position: 0,
          asset: videoAsset
        }
      ],
      usageRecords: []
    };
    const prisma = {
      videoTask: {
        findUnique: async () => null,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          taskCreateData = data;
          return { id: task.id };
        },
        findUniqueOrThrow: async () => task
      },
      asset: {
        findMany: async () => [videoAsset]
      }
    } as unknown as PrismaClient;
    const add = vi.fn(async () => undefined);
    await registerMvpRoutes(server, {
      prisma,
      storage: {} as Storage,
      provider: new SeedanceProviderDefinition({
        modelId: "doubao-seedance-2.0"
      }),
      taskQueue: { add } as unknown as Queue<VideoGenerationJob>,
      uploadMaxBytes: 10 * 1024 * 1024,
      appVideoMaxBytes: 10 * 1024 * 1024,
      assetPublishingConfigured: true
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/tasks",
      payload: {
        clientRequestId: task.clientRequestId,
        model: task.model,
        prompt: task.prompt,
        assetIds: [videoAsset.id],
        parameters: task.parameters
      }
    });

    expect(response.statusCode).toBe(202);
    expect(taskCreateData).toMatchObject({
      assets: {
        create: [
          {
            assetId: videoAsset.id,
            role: "REFERENCE_VIDEO",
            position: 0
          }
        ]
      }
    });
    expect(response.json().referenceAssets).toEqual([
      {
        id: videoAsset.id,
        originalName: "reference.mp4",
        mimeType: "video/mp4",
        kind: "video",
        sizeBytes: 7_309_809,
        durationSeconds: 11.042,
        width: 1280,
        height: 720,
        codec: "h264",
        frameRate: "24/1",
        hasAudio: false
      }
    ]);
    expect(add).toHaveBeenCalledOnce();
  });
});

function multipartRequest(fileName: string, mimeType: string, bytes: Buffer) {
  const boundary = "seedance-fixture-boundary";
  return {
    method: "POST" as const,
    url: "/api/assets",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`
    },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ])
  };
}
