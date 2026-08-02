import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import type { Storage, StorageCandidate } from "./index.js";
import {
  inspectMp4Video,
  type VideoInspectionPolicy,
  type VideoMetadata
} from "./video-inspector.js";

const assetIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const checksumPattern = /^[a-f0-9]{64}$/;
const signaturePattern = /^[A-Za-z0-9_-]{43}$/;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export type AssetPublishingProvider = "seedance";
export type AssetPublishingPurpose = "reference-image" | "reference-video";
export type PublishedAssetRole = "REFERENCE_IMAGE" | "REFERENCE_VIDEO";
export type PublishedImageMimeType = "image/png" | "image/jpeg";
export type PublishedVideoMimeType = "video/mp4";
export type PublishedAssetMimeType =
  PublishedImageMimeType | PublishedVideoMimeType;

export interface PublishableAssetRecord {
  id: string;
  kind: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string | null;
  durationMs?: number | null;
  width?: number | null;
  height?: number | null;
  codec?: string | null;
  pixelFormat?: string | null;
  frameRate?: string | null;
  hasAudio?: boolean | null;
}

export interface PublishForProviderInput {
  assetId: string;
  provider: AssetPublishingProvider;
  purpose: AssetPublishingPurpose;
  minimumTtlMs: number;
}

export interface PublishedProviderAssetFile {
  assetId: string;
  role: PublishedAssetRole;
  mimeType: PublishedAssetMimeType;
  sizeBytes: number;
  checksum: string;
  url: string;
  expiresAt: Date;
  metadata?: VideoMetadata;
  remoteObject?: PublishedRemoteObject;
}

export type PublishedProviderImage = PublishedProviderAssetFile;
export type PublishedProviderVideo = PublishedProviderAssetFile;

export interface PublishedRemoteObject {
  publisher: "eos";
  bucket: string;
  objectKey: string;
}

export interface AuthorizeProviderAssetInput {
  assetId: string;
  provider: string;
  purpose: string;
  expires: string;
  signature: string;
}

export interface AuthorizedProviderAsset extends Omit<
  PublishedProviderAssetFile,
  "url" | "expiresAt"
> {
  storageKey: string;
}

export interface AssetPublisher {
  publishForProvider(
    input: PublishForProviderInput
  ): Promise<PublishedProviderAssetFile>;
  authorizeProviderAsset(
    input: AuthorizeProviderAssetInput
  ): Promise<AuthorizedProviderAsset>;
  deletePublishedAsset?(remoteObject: PublishedRemoteObject): Promise<void>;
}

export type AssetPublishingErrorCode =
  | "ASSET_PUBLISHING_INVALID_CONFIG"
  | "ASSET_PUBLISHING_INVALID_REQUEST"
  | "ASSET_PUBLISHING_TTL_TOO_SHORT"
  | "ASSET_SIGNATURE_INVALID"
  | "ASSET_URL_EXPIRED"
  | "ASSET_NOT_FOUND"
  | "ASSET_TYPE_UNSUPPORTED"
  | "ASSET_EMPTY"
  | "ASSET_TOO_LARGE"
  | "ASSET_METADATA_MISMATCH"
  | "ASSET_FILE_MISSING"
  | "ASSET_FILE_INVALID";

export class AssetPublishingError extends Error {
  constructor(
    readonly code: AssetPublishingErrorCode,
    message: string,
    options: { cause?: unknown } = {}
  ) {
    super(message, options);
    this.name = "AssetPublishingError";
  }
}

export interface SignedAssetPublisherOptions {
  signingKey: string;
  publicBaseUrl: string;
  urlTtlMs: number;
  maxBytes: number;
  videoMaxBytes?: number;
  videoInspectionPolicy?: VideoInspectionPolicy;
  inspectionTimeoutMs?: number;
  storage: Storage;
  loadAsset(assetId: string): Promise<PublishableAssetRecord | null>;
  now?: () => Date;
}

export interface AssetValidationOptions {
  maxBytes: number;
  videoMaxBytes?: number;
  videoInspectionPolicy?: VideoInspectionPolicy;
  inspectionTimeoutMs?: number;
  storage: Storage;
  loadAsset(assetId: string): Promise<PublishableAssetRecord | null>;
}

export interface ValidatedPublishableAsset {
  id: string;
  storageKey: string;
  role: PublishedAssetRole;
  mimeType: PublishedAssetMimeType;
  sizeBytes: number;
  checksum: string;
  metadata?: VideoMetadata;
}

export class SignedAssetPublisher implements AssetPublisher {
  private readonly signingKey: Buffer;
  private readonly publicBaseUrl: URL;
  private readonly urlTtlMs: number;
  private readonly maxBytes: number;
  private readonly videoMaxBytes: number;
  private readonly videoInspectionPolicy: VideoInspectionPolicy;
  private readonly inspectionTimeoutMs: number;
  private readonly storage: Storage;
  private readonly loadAsset: SignedAssetPublisherOptions["loadAsset"];
  private readonly now: () => Date;

  constructor(options: SignedAssetPublisherOptions) {
    this.signingKey = Buffer.from(options.signingKey, "utf8");
    if (this.signingKey.byteLength < 32) {
      throw new AssetPublishingError(
        "ASSET_PUBLISHING_INVALID_CONFIG",
        "Asset signing key must contain at least 32 bytes."
      );
    }
    this.publicBaseUrl = parsePublicBaseUrl(options.publicBaseUrl);
    requirePositiveInteger(options.urlTtlMs, "Asset URL TTL");
    requirePositiveInteger(options.maxBytes, "Asset size limit");
    this.urlTtlMs = options.urlTtlMs;
    this.maxBytes = options.maxBytes;
    this.videoMaxBytes = options.videoMaxBytes ?? options.maxBytes;
    requirePositiveInteger(this.videoMaxBytes, "Video asset size limit");
    this.videoInspectionPolicy = options.videoInspectionPolicy ?? {
      minDurationSeconds: 2,
      maxDurationSeconds: 15
    };
    this.inspectionTimeoutMs = options.inspectionTimeoutMs ?? 10_000;
    requirePositiveInteger(
      this.inspectionTimeoutMs,
      "Asset inspection timeout"
    );
    this.storage = options.storage;
    this.loadAsset = options.loadAsset;
    this.now = options.now ?? (() => new Date());
  }

  async publishForProvider(
    input: PublishForProviderInput
  ): Promise<PublishedProviderAssetFile> {
    validateBoundValues(input.assetId, input.provider, input.purpose);
    requirePositiveInteger(input.minimumTtlMs, "Minimum asset URL TTL");
    if (input.minimumTtlMs > this.urlTtlMs) {
      throw new AssetPublishingError(
        "ASSET_PUBLISHING_TTL_TOO_SHORT",
        "Configured asset URL TTL is shorter than the requested minimum."
      );
    }
    const asset = await this.loadValidatedAsset(input.assetId, input.purpose);
    const expiresAt = new Date(this.now().getTime() + this.urlTtlMs);
    const expires = String(expiresAt.getTime());
    const signature = this.sign(
      input.assetId,
      input.provider,
      input.purpose,
      expires
    );
    const url = new URL(
      `/api/provider-assets/${encodeURIComponent(input.assetId)}`,
      this.publicBaseUrl
    );
    url.searchParams.set("provider", input.provider);
    url.searchParams.set("purpose", input.purpose);
    url.searchParams.set("expires", expires);
    url.searchParams.set("signature", signature);
    return {
      assetId: asset.id,
      role: asset.role,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      checksum: asset.checksum,
      url: url.toString(),
      expiresAt,
      ...(asset.metadata === undefined ? {} : { metadata: asset.metadata })
    };
  }

  async authorizeProviderAsset(
    input: AuthorizeProviderAssetInput
  ): Promise<AuthorizedProviderAsset> {
    validateBoundValues(input.assetId, input.provider, input.purpose);
    const purpose = parsePurpose(input.purpose);
    if (!/^\d{1,16}$/.test(input.expires)) {
      throw new AssetPublishingError(
        "ASSET_SIGNATURE_INVALID",
        "Asset signature is invalid."
      );
    }
    const expiresAt = Number(input.expires);
    if (!Number.isSafeInteger(expiresAt)) {
      throw new AssetPublishingError(
        "ASSET_SIGNATURE_INVALID",
        "Asset signature is invalid."
      );
    }
    const expected = this.sign(
      input.assetId,
      input.provider,
      input.purpose,
      input.expires
    );
    if (!safeSignatureEqual(input.signature, expected)) {
      throw new AssetPublishingError(
        "ASSET_SIGNATURE_INVALID",
        "Asset signature is invalid."
      );
    }
    const currentTime = this.now().getTime();
    if (expiresAt <= currentTime) {
      throw new AssetPublishingError(
        "ASSET_URL_EXPIRED",
        "Asset URL has expired."
      );
    }
    if (expiresAt - currentTime > this.urlTtlMs) {
      throw new AssetPublishingError(
        "ASSET_SIGNATURE_INVALID",
        "Asset signature is invalid."
      );
    }
    const asset = await this.loadValidatedAsset(input.assetId, purpose);
    return {
      assetId: asset.id,
      role: asset.role,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      checksum: asset.checksum,
      storageKey: asset.storageKey,
      ...(asset.metadata === undefined ? {} : { metadata: asset.metadata })
    };
  }

  private sign(
    assetId: string,
    provider: string,
    purpose: string,
    expires: string
  ): string {
    return createHmac("sha256", this.signingKey)
      .update(canonicalPayload(assetId, provider, purpose, expires))
      .digest("base64url");
  }

  private async loadValidatedAsset(
    assetId: string,
    purpose: AssetPublishingPurpose
  ): Promise<ValidatedPublishableAsset> {
    return loadValidatedProviderAsset(
      {
        maxBytes: this.maxBytes,
        videoMaxBytes: this.videoMaxBytes,
        videoInspectionPolicy: this.videoInspectionPolicy,
        inspectionTimeoutMs: this.inspectionTimeoutMs,
        storage: this.storage,
        loadAsset: this.loadAsset
      },
      assetId,
      purpose
    );
  }
}

export async function loadValidatedProviderAsset(
  options: AssetValidationOptions,
  assetId: string,
  purpose: AssetPublishingPurpose = "reference-image"
): Promise<ValidatedPublishableAsset> {
  const record = await options.loadAsset(assetId);
  const expectedKind =
    purpose === "reference-image" ? "INPUT_IMAGE" : "INPUT_VIDEO";
  if (record === null || record.kind !== expectedKind) {
    throw new AssetPublishingError(
      "ASSET_NOT_FOUND",
      "Provider asset was not found."
    );
  }
  const mimeType =
    purpose === "reference-image"
      ? parseImageMimeType(record.mimeType)
      : parseVideoMimeType(record.mimeType);
  const maxBytes =
    purpose === "reference-image"
      ? options.maxBytes
      : (options.videoMaxBytes ?? options.maxBytes);
  if (record.sizeBytes <= 0) {
    throw new AssetPublishingError("ASSET_EMPTY", "Provider asset is empty.");
  }
  if (record.sizeBytes > maxBytes) {
    throw new AssetPublishingError(
      "ASSET_TOO_LARGE",
      "Provider asset exceeds the configured size limit."
    );
  }
  const checksum = record.checksum?.toLowerCase();
  if (checksum === undefined || !checksumPattern.test(checksum)) {
    throw new AssetPublishingError(
      "ASSET_METADATA_MISMATCH",
      "Provider asset checksum metadata is invalid."
    );
  }
  let inspected;
  try {
    let metadata: VideoMetadata | undefined;
    inspected = await options.storage.inspect(record.storageKey, {
      maxBytes,
      timeoutMs: options.inspectionTimeoutMs ?? 10_000,
      validate: async (candidate) => {
        if (purpose === "reference-image") {
          await validateImageBytes(
            candidate,
            mimeType as PublishedImageMimeType
          );
          return;
        }
        metadata = await inspectMp4Video(
          candidate,
          options.videoInspectionPolicy ?? {
            minDurationSeconds: 2,
            maxDurationSeconds: 15
          }
        );
      }
    });
    if (purpose === "reference-video") {
      validateStoredVideoMetadata(record, metadata);
    }
  } catch (error) {
    if (isFileMissingError(error)) {
      throw new AssetPublishingError(
        "ASSET_FILE_MISSING",
        "Provider asset file is missing.",
        { cause: error }
      );
    }
    if (error instanceof AssetPublishingError) throw error;
    throw new AssetPublishingError(
      "ASSET_FILE_INVALID",
      "Provider asset file failed validation.",
      { cause: error }
    );
  }
  if (
    inspected.sizeBytes !== record.sizeBytes ||
    inspected.sha256 !== checksum
  ) {
    throw new AssetPublishingError(
      "ASSET_METADATA_MISMATCH",
      "Provider asset file does not match database metadata."
    );
  }
  return {
    id: record.id,
    storageKey: record.storageKey,
    role: purpose === "reference-image" ? "REFERENCE_IMAGE" : "REFERENCE_VIDEO",
    mimeType,
    sizeBytes: inspected.sizeBytes,
    checksum,
    ...(purpose === "reference-video"
      ? {
          metadata: recordVideoMetadata(record)
        }
      : {})
  };
}

export function isSupportedProviderImageMimeType(
  value: string
): value is PublishedImageMimeType {
  return value === "image/png" || value === "image/jpeg";
}

export function isSupportedProviderVideoMimeType(
  value: string
): value is PublishedVideoMimeType {
  return value === "video/mp4";
}

function parseImageMimeType(value: string): PublishedImageMimeType {
  if (isSupportedProviderImageMimeType(value)) return value;
  throw new AssetPublishingError(
    "ASSET_TYPE_UNSUPPORTED",
    "Provider asset MIME type is not supported."
  );
}

function parseVideoMimeType(value: string): PublishedVideoMimeType {
  if (isSupportedProviderVideoMimeType(value)) return value;
  throw new AssetPublishingError(
    "ASSET_TYPE_UNSUPPORTED",
    "Provider video MIME type is not supported."
  );
}

function validateStoredVideoMetadata(
  record: PublishableAssetRecord,
  inspected: VideoMetadata | undefined
): void {
  if (inspected === undefined) {
    throw new AssetPublishingError(
      "ASSET_FILE_INVALID",
      "Provider video metadata is unavailable."
    );
  }
  const stored = recordVideoMetadata(record);
  if (
    Math.abs(stored.durationSeconds - inspected.durationSeconds) > 0.002 ||
    stored.width !== inspected.width ||
    stored.height !== inspected.height ||
    stored.codec !== inspected.codec ||
    stored.pixelFormat !== inspected.pixelFormat ||
    stored.frameRate !== inspected.frameRate ||
    stored.hasAudio !== inspected.hasAudio
  ) {
    throw new AssetPublishingError(
      "ASSET_METADATA_MISMATCH",
      "Provider video file does not match database metadata."
    );
  }
}

function recordVideoMetadata(record: PublishableAssetRecord): VideoMetadata {
  const durationMs = record.durationMs;
  if (
    durationMs === null ||
    durationMs === undefined ||
    !Number.isSafeInteger(durationMs) ||
    durationMs <= 0 ||
    !Number.isSafeInteger(record.width) ||
    Number(record.width) <= 0 ||
    !Number.isSafeInteger(record.height) ||
    Number(record.height) <= 0 ||
    typeof record.codec !== "string" ||
    record.codec.length === 0 ||
    (record.pixelFormat !== null &&
      record.pixelFormat !== undefined &&
      typeof record.pixelFormat !== "string") ||
    typeof record.frameRate !== "string" ||
    !/^\d+\/\d+$/.test(record.frameRate) ||
    typeof record.hasAudio !== "boolean"
  ) {
    throw new AssetPublishingError(
      "ASSET_METADATA_MISMATCH",
      "Provider video metadata is incomplete."
    );
  }
  return {
    durationSeconds: durationMs / 1_000,
    width: Number(record.width),
    height: Number(record.height),
    codec: record.codec,
    pixelFormat: record.pixelFormat ?? null,
    frameRate: record.frameRate,
    hasAudio: record.hasAudio,
    container: "mp4"
  };
}

async function validateImageBytes(
  candidate: StorageCandidate,
  expectedMimeType: PublishedImageMimeType
): Promise<void> {
  if (candidate.sizeBytes === 0) {
    throw new AssetPublishingError("ASSET_EMPTY", "Provider asset is empty.");
  }
  const prefix = await readPrefix(candidate, 8);
  const detected = prefix.subarray(0, 8).equals(pngSignature)
    ? "image/png"
    : prefix.length >= 3 &&
        prefix[0] === 0xff &&
        prefix[1] === 0xd8 &&
        prefix[2] === 0xff
      ? "image/jpeg"
      : null;
  if (detected === null || detected !== expectedMimeType) {
    throw new AssetPublishingError(
      "ASSET_METADATA_MISMATCH",
      "Provider asset MIME metadata does not match its bytes."
    );
  }
}

async function readPrefix(
  candidate: StorageCandidate,
  byteCount: number
): Promise<Buffer> {
  const stream = candidate.openReadStream();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const value = Buffer.from(chunk as Uint8Array);
      const remaining = byteCount - total;
      chunks.push(value.subarray(0, remaining));
      total += Math.min(value.length, remaining);
      if (total >= byteCount) break;
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks, total);
}

function parsePublicBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new AssetPublishingError(
      "ASSET_PUBLISHING_INVALID_CONFIG",
      "Asset public Base URL is invalid.",
      { cause: error }
    );
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    (url.pathname !== "/" && url.pathname !== "") ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    !hostname.includes(".") ||
    isIP(hostname) !== 0
  ) {
    throw new AssetPublishingError(
      "ASSET_PUBLISHING_INVALID_CONFIG",
      "Asset public Base URL must be an external HTTPS origin."
    );
  }
  return url;
}

function validateBoundValues(
  assetId: string,
  provider: string,
  purpose: string
): void {
  if (
    !assetIdPattern.test(assetId) ||
    provider !== "seedance" ||
    (purpose !== "reference-image" && purpose !== "reference-video")
  ) {
    throw new AssetPublishingError(
      "ASSET_PUBLISHING_INVALID_REQUEST",
      "Provider asset request is invalid."
    );
  }
}

function parsePurpose(value: string): AssetPublishingPurpose {
  if (value === "reference-image" || value === "reference-video") {
    return value;
  }
  throw new AssetPublishingError(
    "ASSET_PUBLISHING_INVALID_REQUEST",
    "Provider asset request is invalid."
  );
}

function canonicalPayload(
  assetId: string,
  provider: string,
  purpose: string,
  expires: string
): string {
  return ["v1", assetId, provider, purpose, expires].join("\n");
}

function safeSignatureEqual(supplied: string, expected: string): boolean {
  if (!signaturePattern.test(supplied)) return false;
  const suppliedBuffer = Buffer.from(supplied, "base64url");
  const expectedBuffer = Buffer.from(expected, "base64url");
  return (
    suppliedBuffer.byteLength === expectedBuffer.byteLength &&
    timingSafeEqual(suppliedBuffer, expectedBuffer)
  );
}

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AssetPublishingError(
      "ASSET_PUBLISHING_INVALID_CONFIG",
      `${label} must be a positive safe integer.`
    );
  }
}

function isFileMissingError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
