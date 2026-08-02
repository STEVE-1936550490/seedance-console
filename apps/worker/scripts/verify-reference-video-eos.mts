import { createHash } from "node:crypto";
import { basename, dirname, resolve } from "node:path";

import {
  SeedanceProviderAdapter,
  type BridgeCreateVideoTaskRequest,
  type SeedanceBridgeTransport
} from "@seedance/seedance-provider";
import {
  LocalStorage,
  S3PresignedAssetPublisher,
  inspectMp4Video,
  type PublishedRemoteObject,
  type VideoMetadata
} from "@seedance/storage";

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
};
const positiveInteger = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim();
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
};

const inputPath = resolve(required("REFERENCE_VIDEO_PATH"));
const storage = new LocalStorage(dirname(inputPath));
const storageKey = basename(inputPath);
const videoMaxBytes = positiveInteger("APP_VIDEO_MAX_BYTES", 10 * 1024 * 1024);
let metadata: VideoMetadata | undefined;
const inspected = await storage.inspect(storageKey, {
  maxBytes: videoMaxBytes,
  timeoutMs: 30_000,
  validate: async (candidate) => {
    metadata = await inspectMp4Video(candidate, {
      minDurationSeconds: 2,
      maxDurationSeconds: 15,
      ffprobePath: process.env.FFPROBE_PATH?.trim() || "ffprobe"
    });
  }
});
if (metadata === undefined) throw new Error("Video metadata was not produced.");

const expectedSize = positiveInteger(
  "REFERENCE_VIDEO_EXPECTED_SIZE",
  inspected.sizeBytes
);
const expectedSha256 = required(
  "REFERENCE_VIDEO_EXPECTED_SHA256"
).toLowerCase();
if (
  inspected.sizeBytes !== expectedSize ||
  inspected.sha256 !== expectedSha256
) {
  throw new Error(
    "Reference video size or SHA-256 does not match its evidence."
  );
}

const assetId = "reference-video-verification";
const record = {
  id: assetId,
  kind: "INPUT_VIDEO",
  storageKey,
  mimeType: "video/mp4",
  sizeBytes: inspected.sizeBytes,
  checksum: inspected.sha256,
  durationMs: Math.round(metadata.durationSeconds * 1_000),
  width: metadata.width,
  height: metadata.height,
  codec: metadata.codec,
  pixelFormat: metadata.pixelFormat,
  frameRate: metadata.frameRate,
  hasAudio: metadata.hasAudio
};
const publisher = new S3PresignedAssetPublisher({
  endpoint: required("EOS_ENDPOINT"),
  region: required("EOS_REGION"),
  bucket: required("EOS_BUCKET"),
  accessKeyId: required("EOS_ACCESS_KEY_ID"),
  secretAccessKey: required("EOS_SECRET_ACCESS_KEY"),
  objectPrefix: process.env.EOS_OBJECT_PREFIX?.trim() || "seedance-inputs/",
  presignTtlSeconds: 300,
  forcePathStyle: process.env.EOS_FORCE_PATH_STYLE === "true",
  maxBytes: positiveInteger("SEEDANCE_ASSET_MAX_BYTES", 10 * 1024 * 1024),
  videoMaxBytes,
  videoInspectionPolicy: {
    minDurationSeconds: 2,
    maxDurationSeconds: 15,
    ffprobePath: process.env.FFPROBE_PATH?.trim() || "ffprobe"
  },
  storage,
  loadAsset: async (candidateId) => (candidateId === assetId ? record : null)
});

let remoteObject: PublishedRemoteObject | undefined;
let deleted = false;
let deletedGetStatus: number | undefined;
try {
  const published = await publisher.publishForProvider({
    assetId,
    provider: "seedance",
    purpose: "reference-video",
    minimumTtlMs: 300_000
  });
  remoteObject = published.remoteObject;
  if (remoteObject === undefined)
    throw new Error("EOS object was not recorded.");

  const response = await fetch(published.url, { redirect: "error" });
  if (!response.ok)
    throw new Error(`Presigned GET returned HTTP ${response.status}.`);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0];
  const contentLength = Number(response.headers.get("content-length"));
  const bytes = Buffer.from(await response.arrayBuffer());
  const downloadedSha256 = createHash("sha256").update(bytes).digest("hex");
  if (
    contentType !== "video/mp4" ||
    contentLength !== inspected.sizeBytes ||
    bytes.byteLength !== inspected.sizeBytes ||
    downloadedSha256 !== inspected.sha256
  ) {
    throw new Error("Presigned video GET metadata or SHA-256 does not match.");
  }

  let captured: BridgeCreateVideoTaskRequest | undefined;
  const bridge: SeedanceBridgeTransport = {
    createTask: async (request) => {
      captured = request;
      return { id: "not-sent-fixture" };
    },
    recoverTask: async () => null,
    getTask: async () => ({ status: "running" }),
    downloadOutput: async () => {
      throw new Error("No Provider output exists in dry-run verification.");
    }
  };
  const model = required("SEEDANCE_MODEL_ID");
  const adapter = new SeedanceProviderAdapter({
    modelId: model,
    bridgeClient: bridge
  });
  await adapter.createTask({
    clientRequestId: "reference-video-dry-run",
    model,
    prompt: "全程参考视频1的主体与运镜。",
    referenceAssetIds: [assetId],
    publishedAssets: [{ ...published, position: 0 }],
    parameters: {
      ratio: "16:9",
      duration: 11,
      generateAudio: false,
      watermark: false
    }
  });
  if (captured === undefined)
    throw new Error("Dry-run request was not captured.");

  await publisher.deletePublishedAsset(remoteObject);
  deleted = true;
  const deletedResponse = await fetch(published.url, { redirect: "error" });
  deletedGetStatus = deletedResponse.status;
  if (deletedGetStatus !== 404) {
    throw new Error(
      `Deleted object verification returned HTTP ${deletedGetStatus}.`
    );
  }

  const videoContent = captured.request.content[1];
  if (videoContent?.type !== "video_url") {
    throw new Error("Dry-run request did not contain video_url.");
  }
  console.log(
    JSON.stringify({
      ok: true,
      providerCreateSent: false,
      model,
      input: {
        sizeBytes: inspected.sizeBytes,
        sha256: inspected.sha256,
        ...metadata
      },
      presignedGet: {
        status: response.status,
        contentType,
        contentLength,
        sha256: downloadedSha256
      },
      request: {
        headers: { "Input-Has-Video": "true" },
        content: [
          { type: "text", text: "<redacted-prompt>" },
          {
            type: "video_url",
            video_url: { url: "<redacted-presigned-https-url>" },
            role: "reference_video"
          }
        ],
        generate_audio: captured.request.generate_audio,
        ratio: captured.request.ratio,
        duration: captured.request.duration,
        watermark: captured.request.watermark
      },
      eos: {
        objectKeyPrefix: `${remoteObject.objectKey.slice(0, 32)}…`,
        deleted,
        deletedGetStatus
      }
    })
  );
} finally {
  if (remoteObject !== undefined && !deleted) {
    await publisher.deletePublishedAsset(remoteObject).catch(() => undefined);
  }
}
