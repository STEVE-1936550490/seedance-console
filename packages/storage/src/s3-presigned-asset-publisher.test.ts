import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PublishableAssetRecord } from "./asset-publisher.js";
import { LocalStorage } from "./index.js";
import { S3PresignedAssetPublisher } from "./s3-presigned-asset-publisher.js";

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.from("fixture-png")
]);
const jpeg = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from("fixture-jpeg")
]);

describe("S3PresignedAssetPublisher", () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  async function fixture(
    bytes = png,
    overrides: Partial<PublishableAssetRecord> = {}
  ) {
    const root = await mkdtemp(join(tmpdir(), "seedance-eos-"));
    roots.push(root);
    const storage = new LocalStorage(root);
    const storageKey =
      overrides.kind === "INPUT_VIDEO"
        ? "inputs/videos/private-name.mp4"
        : "inputs/private-name.png";
    await storage.put(storageKey, Readable.from(bytes));
    const record: PublishableAssetRecord = {
      id: "asset-one",
      kind: "INPUT_IMAGE",
      storageKey,
      mimeType: "image/png",
      sizeBytes: bytes.byteLength,
      checksum: createHash("sha256").update(bytes).digest("hex"),
      ...overrides
    };
    const commands: unknown[] = [];
    const client = {
      send: vi.fn(async (command: unknown) => {
        commands.push(command);
        return {};
      })
    };
    const presign = vi.fn(
      async (_client, _command, options: { expiresIn: number }) =>
        `https://objects.example.com/private?X-Amz-Expires=${options.expiresIn}&X-Amz-Signature=redacted`
    );
    const publisher = new S3PresignedAssetPublisher({
      endpoint: "https://objects.example.com",
      region: "configurable-region",
      bucket: "private-bucket",
      accessKeyId: "fixture-access-key",
      secretAccessKey: "fixture-secret-key",
      objectPrefix: "seedance-inputs/",
      presignTtlSeconds: 3_600,
      maxBytes: 1_024,
      videoMaxBytes: 20 * 1024 * 1024,
      videoInspectionPolicy: {
        minDurationSeconds: 2,
        maxDurationSeconds: 15
      },
      storage,
      loadAsset: async (assetId) => (assetId === record.id ? record : null),
      now: () => new Date("2026-08-01T00:00:00.000Z"),
      client: client as never,
      presign: presign as never
    });
    return { publisher, commands, client, presign };
  }

  it.each([
    ["PNG", png, "image/png"],
    ["JPEG", jpeg, "image/jpeg"]
  ])(
    "uploads %s privately and generates an expiring GET URL",
    async (_label, bytes, mimeType) => {
      const { publisher, commands, presign } = await fixture(bytes, {
        mimeType
      });
      const result = await publisher.publishForProvider({
        assetId: "asset-one",
        provider: "seedance",
        purpose: "reference-image",
        minimumTtlMs: 300_000
      });

      expect(commands[0]).toBeInstanceOf(PutObjectCommand);
      const input = (commands[0] as PutObjectCommand).input;
      expect(input).toMatchObject({
        Bucket: "private-bucket",
        ContentLength: bytes.byteLength,
        ContentType: mimeType
      });
      expect(input.Key).toMatch(/^seedance-inputs\/[a-f0-9]{64}$/);
      expect(input.Key).not.toContain("private-name");
      expect(presign).toHaveBeenCalledOnce();
      expect(new URL(result.url).searchParams.get("X-Amz-Expires")).toBe(
        "3600"
      );
      expect(result.expiresAt).toEqual(new Date("2026-08-01T01:00:00.000Z"));
      expect(result.remoteObject).toEqual({
        publisher: "eos",
        bucket: "private-bucket",
        objectKey: input.Key
      });
    }
  );

  it("uploads a validated MP4 under an unpredictable video prefix", async () => {
    const video = await readFile(
      new URL(
        "../../seedance-provider/fixtures/mock-output.mp4",
        import.meta.url
      )
    );
    const { publisher, commands } = await fixture(video, {
      kind: "INPUT_VIDEO",
      mimeType: "video/mp4",
      durationMs: 3_000,
      width: 1280,
      height: 720,
      codec: "h264",
      pixelFormat: "yuv420p",
      frameRate: "24/1",
      hasAudio: false
    });
    const result = await publisher.publishForProvider({
      assetId: "asset-one",
      provider: "seedance",
      purpose: "reference-video",
      minimumTtlMs: 300_000
    });
    const input = (commands[0] as PutObjectCommand).input;
    expect(input).toMatchObject({
      ContentLength: video.byteLength,
      ContentType: "video/mp4"
    });
    expect(input.Key).toMatch(/^seedance-inputs\/videos\/[a-f0-9]{64}$/);
    expect(result).toMatchObject({
      role: "REFERENCE_VIDEO",
      mimeType: "video/mp4",
      metadata: { durationSeconds: 3, codec: "h264" }
    });
  });

  it("rejects an unsupported MIME type and oversized files before upload", async () => {
    const unsupported = await fixture(png, { mimeType: "image/webp" });
    await expect(
      unsupported.publisher.publishForProvider({
        assetId: "asset-one",
        provider: "seedance",
        purpose: "reference-image",
        minimumTtlMs: 1
      })
    ).rejects.toMatchObject({ code: "ASSET_TYPE_UNSUPPORTED" });
    expect(unsupported.client.send).not.toHaveBeenCalled();

    const oversized = await fixture(png, { sizeBytes: 2_048 });
    await expect(
      oversized.publisher.publishForProvider({
        assetId: "asset-one",
        provider: "seedance",
        purpose: "reference-image",
        minimumTtlMs: 1
      })
    ).rejects.toMatchObject({ code: "ASSET_TOO_LARGE" });
    expect(oversized.client.send).not.toHaveBeenCalled();
  });

  it("uses the SDK SigV4 presigner without making a network request", async () => {
    const client = new S3Client({
      endpoint: "https://objects.example.com",
      region: "configurable-region",
      credentials: {
        accessKeyId: "fixture-access-key",
        secretAccessKey: "fixture-secret-key"
      }
    });
    const signed = await getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: "private-bucket",
        Key: "seedance-inputs/random-object"
      }),
      { expiresIn: 3_600 }
    );
    client.destroy();
    const url = new URL(signed);
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
  });

  it("does not log credentials or the complete presigned URL", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { publisher } = await fixture();
    await publisher.publishForProvider({
      assetId: "asset-one",
      provider: "seedance",
      purpose: "reference-image",
      minimumTtlMs: 1
    });
    const output = [...log.mock.calls, ...error.mock.calls].flat().join(" ");
    expect(output).not.toContain("fixture-secret-key");
    expect(output).not.toContain("X-Amz-Signature");
  });

  it("does not presign when the object upload fails", async () => {
    const fixtureValue = await fixture();
    fixtureValue.client.send.mockRejectedValueOnce(new Error("upload failed"));
    await expect(
      fixtureValue.publisher.publishForProvider({
        assetId: "asset-one",
        provider: "seedance",
        purpose: "reference-image",
        minimumTtlMs: 1
      })
    ).rejects.toMatchObject({ code: "ASSET_FILE_INVALID" });
    expect(fixtureValue.presign).not.toHaveBeenCalled();
  });

  it("deletes the uploaded object when presigning fails", async () => {
    const fixtureValue = await fixture();
    fixtureValue.presign.mockRejectedValueOnce(new Error("signing failed"));
    await expect(
      fixtureValue.publisher.publishForProvider({
        assetId: "asset-one",
        provider: "seedance",
        purpose: "reference-image",
        minimumTtlMs: 1
      })
    ).rejects.toMatchObject({ code: "ASSET_FILE_INVALID" });
    expect(fixtureValue.commands[1]).toBeInstanceOf(DeleteObjectCommand);
  });
});
