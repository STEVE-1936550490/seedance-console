import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import type { PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { validateMp4Stream } from "../../worker/src/download-processor.js";
import { registerMvpRoutes } from "./mvp-routes.js";
import {
  MockSeedanceProvider,
  SeedanceProviderAdapter,
  type BridgeCreateVideoTaskRequest,
  type BridgeQueryVideoTaskResponse,
  type ProviderDownload
} from "@seedance/seedance-provider";
import type { VideoGenerationJob } from "@seedance/shared";
import {
  LocalStorage,
  SignedAssetPublisher,
  type PublishableAssetRecord
} from "@seedance/storage";

describe("reference-image fixture Bridge E2E", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots
        .splice(0)
        .map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  it("uploads, publishes, submits, polls, downloads, persists, and serves video", async () => {
    const root = await mkdtemp(join(tmpdir(), "seedance-image-e2e-"));
    temporaryRoots.push(root);
    const storage = new LocalStorage(root);
    const image = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.from("fixture-reference-image")
    ]);
    await storage.put("inputs/reference.png", Readable.from(image));
    const imageRecord: PublishableAssetRecord = {
      id: "asset-reference",
      kind: "INPUT_IMAGE",
      storageKey: "inputs/reference.png",
      mimeType: "image/png",
      sizeBytes: image.byteLength,
      checksum: createHash("sha256").update(image).digest("hex")
    };
    const publisher = new SignedAssetPublisher({
      signingKey: "fixture-e2e-signing-key-at-least-32-bytes",
      publicBaseUrl: "https://assets.example.com",
      urlTtlMs: 120_000,
      maxBytes: 1_024,
      storage,
      loadAsset: async (assetId) =>
        assetId === imageRecord.id ? imageRecord : null
    });
    const state: {
      outputMetadata?: {
        storageKey: string;
        mimeType: string;
        sizeBytes: bigint;
      };
    } = {};
    const prisma = {
      taskAsset: {
        findFirst: async () =>
          state.outputMetadata === undefined
            ? null
            : { asset: state.outputMetadata }
      }
    } as unknown as PrismaClient;
    const server = Fastify({ logger: false });
    await registerMvpRoutes(server, {
      prisma,
      provider: new MockSeedanceProvider(),
      taskQueue: {} as Queue<VideoGenerationJob>,
      storage,
      uploadMaxBytes: 1_024,
      assetPublisher: publisher
    });

    const published = await publisher.publishForProvider({
      assetId: imageRecord.id,
      provider: "seedance",
      purpose: "reference-image",
      minimumTtlMs: 60_000
    });
    let pollCount = 0;
    const output = await readFile(
      new URL(
        "../../../packages/seedance-provider/fixtures/mock-output.mp4",
        import.meta.url
      )
    );
    const bridge = {
      createTask: async (request: BridgeCreateVideoTaskRequest) => {
        const content = request.request.content[1];
        expect(content?.type).toBe("image_url");
        if (content?.type !== "image_url") throw new Error("image missing");
        const url = new URL(content.image_url.url);
        const fetched = await server.inject({
          method: "GET",
          url: `${url.pathname}${url.search}`
        });
        expect(fetched.statusCode).toBe(200);
        expect(fetched.rawPayload).toEqual(image);
        return { id: "fixture-provider-task" };
      },
      recoverTask: async () => null,
      getTask: async (): Promise<BridgeQueryVideoTaskResponse> => {
        pollCount += 1;
        return pollCount === 1
          ? { status: "running" }
          : {
              status: "succeeded",
              content: { video_url: "https://output.example.com/video.mp4" }
            };
      },
      downloadOutput: async (): Promise<ProviderDownload> => ({
        body: Readable.from(output),
        contentType: "video/mp4",
        contentLength: output.byteLength
      })
    };
    const adapter = new SeedanceProviderAdapter({
      modelId: "fixture-model",
      bridgeClient: bridge
    });

    const submitted = await adapter.createTask({
      clientRequestId: "fixture-image-request",
      model: "fixture-model",
      prompt: "A fixture reference-image video",
      referenceAssetIds: [imageRecord.id],
      publishedAssets: [{ ...published, position: 0 }],
      parameters: {
        ratio: "16:9",
        duration: 11,
        generateAudio: false,
        watermark: false
      }
    });
    expect(submitted.providerTaskId).toBe("fixture-provider-task");
    await expect(
      adapter.getTask(submitted.providerTaskId)
    ).resolves.toMatchObject({
      status: "PROCESSING"
    });
    await expect(
      adapter.getTask(submitted.providerTaskId)
    ).resolves.toMatchObject({
      status: "SUCCEEDED"
    });
    const download = await adapter.downloadOutput(submitted.providerTaskId, {
      kind: "video"
    });
    const stored = await storage.putAtomic(
      "outputs/task-reference/video.mp4",
      download.body,
      {
        maxBytes: output.byteLength + 1_024,
        timeoutMs: 2_000,
        validate: async (candidate) =>
          validateMp4Stream(candidate.openReadStream(), candidate.sizeBytes)
      }
    );
    state.outputMetadata = {
      storageKey: "outputs/task-reference/video.mp4",
      mimeType: "video/mp4",
      sizeBytes: BigInt(stored.sizeBytes)
    };
    const preview = await server.inject({
      method: "GET",
      url: "/api/tasks/task-reference/video"
    });
    const attachment = await server.inject({
      method: "GET",
      url: "/api/tasks/task-reference/download"
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.rawPayload).toEqual(output);
    expect(attachment.headers["content-disposition"]).toContain("attachment");
    await server.close();
  });
});
