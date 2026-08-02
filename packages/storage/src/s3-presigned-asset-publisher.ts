import { createHash, randomBytes } from "node:crypto";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import {
  AssetPublishingError,
  loadValidatedProviderAsset,
  type AssetPublisher,
  type AssetValidationOptions,
  type AuthorizedProviderAsset,
  type PublishedProviderAssetFile,
  type PublishedRemoteObject,
  type PublishForProviderInput
} from "./asset-publisher.js";

export interface S3PresignedAssetPublisherOptions extends AssetValidationOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  objectPrefix?: string;
  presignTtlSeconds: number;
  forcePathStyle?: boolean;
  now?: () => Date;
  verifyPresignedGet?: boolean;
  fetchImplementation?: typeof fetch;
  client?: Pick<S3Client, "send">;
  presign?: (
    client: S3Client,
    command: GetObjectCommand,
    options: { expiresIn: number }
  ) => Promise<string>;
}

export class S3PresignedAssetPublisher implements AssetPublisher {
  private readonly bucket: string;
  private readonly objectPrefix: string;
  private readonly presignTtlSeconds: number;
  private readonly validation: AssetValidationOptions;
  private readonly client: Pick<S3Client, "send">;
  private readonly presign: NonNullable<
    S3PresignedAssetPublisherOptions["presign"]
  >;
  private readonly now: () => Date;
  private readonly verifyPresignedGet: boolean;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: S3PresignedAssetPublisherOptions) {
    requireHttpsEndpoint(options.endpoint);
    requireNonEmpty(options.region, "EOS region");
    requireNonEmpty(options.bucket, "EOS bucket");
    requireNonEmpty(options.accessKeyId, "EOS access key ID");
    requireNonEmpty(options.secretAccessKey, "EOS secret access key");
    if (
      !Number.isSafeInteger(options.presignTtlSeconds) ||
      options.presignTtlSeconds <= 0 ||
      options.presignTtlSeconds > 604_800
    ) {
      throw invalidConfig(
        "EOS presign TTL must be between 1 and 604800 seconds."
      );
    }
    this.bucket = options.bucket;
    this.objectPrefix = parseObjectPrefix(
      options.objectPrefix ?? "seedance-inputs/"
    );
    this.presignTtlSeconds = options.presignTtlSeconds;
    this.validation = {
      maxBytes: options.maxBytes,
      ...(options.videoMaxBytes === undefined
        ? {}
        : { videoMaxBytes: options.videoMaxBytes }),
      ...(options.videoInspectionPolicy === undefined
        ? {}
        : { videoInspectionPolicy: options.videoInspectionPolicy }),
      ...(options.inspectionTimeoutMs === undefined
        ? {}
        : { inspectionTimeoutMs: options.inspectionTimeoutMs }),
      storage: options.storage,
      loadAsset: options.loadAsset
    };
    this.client =
      options.client ??
      new S3Client({
        endpoint: options.endpoint,
        region: options.region,
        forcePathStyle: options.forcePathStyle ?? false,
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
        credentials: {
          accessKeyId: options.accessKeyId,
          secretAccessKey: options.secretAccessKey
        }
      });
    this.presign = options.presign ?? getSignedUrl;
    this.now = options.now ?? (() => new Date());
    this.verifyPresignedGet = options.verifyPresignedGet ?? false;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async publishForProvider(
    input: PublishForProviderInput
  ): Promise<PublishedProviderAssetFile> {
    if (
      input.provider !== "seedance" ||
      (input.purpose !== "reference-image" &&
        input.purpose !== "reference-video")
    ) {
      throw new AssetPublishingError(
        "ASSET_PUBLISHING_INVALID_REQUEST",
        "Provider asset request is invalid."
      );
    }
    const minimumTtlSeconds = Math.ceil(input.minimumTtlMs / 1_000);
    if (minimumTtlSeconds > this.presignTtlSeconds) {
      throw new AssetPublishingError(
        "ASSET_PUBLISHING_TTL_TOO_SHORT",
        "Configured asset URL TTL is shorter than the requested minimum."
      );
    }
    const asset = await loadValidatedProviderAsset(
      this.validation,
      input.assetId,
      input.purpose
    );
    const objectKey = `${this.objectPrefix}${
      input.purpose === "reference-video" ? "videos/" : ""
    }${randomBytes(32).toString("hex")}`;
    const remoteObject: PublishedRemoteObject = {
      publisher: "eos",
      bucket: this.bucket,
      objectKey
    };

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
          Body: this.validation.storage.openReadStream(asset.storageKey),
          ContentLength: asset.sizeBytes,
          ContentType: asset.mimeType
        })
      );
    } catch (error) {
      throw new AssetPublishingError(
        "ASSET_FILE_INVALID",
        "Provider asset object upload failed.",
        { cause: error }
      );
    }

    try {
      const url = await this.presign(
        this.client as S3Client,
        new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }),
        { expiresIn: this.presignTtlSeconds }
      );
      if (this.verifyPresignedGet) {
        const response = await this.fetchImplementation(url, {
          redirect: "error",
          signal: AbortSignal.timeout(30_000)
        });
        const contentType = response.headers
          .get("content-type")
          ?.split(";", 1)[0];
        const contentLength = Number(response.headers.get("content-length"));
        if (
          response.status !== 200 ||
          contentType !== asset.mimeType ||
          contentLength !== asset.sizeBytes
        ) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error("Presigned Provider asset GET validation failed.");
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        if (
          bytes.byteLength !== asset.sizeBytes ||
          createHash("sha256").update(bytes).digest("hex") !== asset.checksum
        ) {
          throw new Error(
            "Presigned Provider asset checksum validation failed."
          );
        }
      }
      return {
        assetId: asset.id,
        role: asset.role,
        mimeType: asset.mimeType,
        sizeBytes: asset.sizeBytes,
        checksum: asset.checksum,
        url,
        expiresAt: new Date(
          this.now().getTime() + this.presignTtlSeconds * 1_000
        ),
        remoteObject,
        ...(asset.metadata === undefined ? {} : { metadata: asset.metadata })
      };
    } catch (error) {
      await this.deletePublishedAsset(remoteObject).catch(() => undefined);
      throw new AssetPublishingError(
        "ASSET_FILE_INVALID",
        "Provider asset URL signing failed.",
        { cause: error }
      );
    }
  }

  async deletePublishedAsset(
    remoteObject: PublishedRemoteObject
  ): Promise<void> {
    if (
      remoteObject.publisher !== "eos" ||
      remoteObject.bucket !== this.bucket ||
      !remoteObject.objectKey.startsWith(this.objectPrefix)
    ) {
      throw new AssetPublishingError(
        "ASSET_PUBLISHING_INVALID_REQUEST",
        "Published object does not belong to this publisher."
      );
    }
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: remoteObject.bucket,
        Key: remoteObject.objectKey
      })
    );
  }

  authorizeProviderAsset(): Promise<AuthorizedProviderAsset> {
    return Promise.reject(
      new AssetPublishingError(
        "ASSET_PUBLISHING_INVALID_REQUEST",
        "EOS presigned assets are authorized by object storage."
      )
    );
  }
}

function requireHttpsEndpoint(value: string): void {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw invalidConfig("EOS endpoint must be a valid HTTPS URL.");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    endpoint.search.length > 0 ||
    endpoint.hash.length > 0
  ) {
    throw invalidConfig("EOS endpoint must be a valid HTTPS URL.");
  }
}

function requireNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw invalidConfig(`${label} is required.`);
}

function parseObjectPrefix(value: string): string {
  if (
    value.length === 0 ||
    value.length > 512 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").some((part) => part === "." || part === "..")
  ) {
    throw invalidConfig("EOS object prefix is invalid.");
  }
  return value.endsWith("/") ? value : `${value}/`;
}

function invalidConfig(message: string): AssetPublishingError {
  return new AssetPublishingError("ASSET_PUBLISHING_INVALID_CONFIG", message);
}
