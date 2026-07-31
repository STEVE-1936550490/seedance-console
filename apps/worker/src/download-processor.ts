import { Buffer } from "node:buffer";
import type { Readable } from "node:stream";

import {
  ProviderDownloadValidationError,
  ProviderOperationError,
  ProviderOutputExpiredError,
  type ProviderDownload,
  type SeedanceProvider
} from "@seedance/seedance-provider";
import {
  StorageLimitError,
  StorageTimeoutError,
  type Storage,
  type StorageCandidate
} from "@seedance/storage";

import type { ProviderJobScheduler } from "./job-scheduler.js";
import type {
  DownloadClaim,
  StoredVideoOutput,
  TaskStore,
  VideoOutputMetadata
} from "./task-store.js";

const outputMimeType = "video/mp4";

export interface DownloadPolicy {
  maxBytes: number;
  timeoutMs: number;
  baseRetryIntervalMs: number;
  maxRetryIntervalMs: number;
  maxAttempts: number;
  jitterRatio: number;
}

export interface DownloadProcessorDependencies {
  store: DownloadTaskStore;
  provider: SeedanceProvider;
  storage: Storage;
  scheduler: ProviderJobScheduler;
  policy: DownloadPolicy;
  now?: () => Date;
  random?: () => number;
}

export type DownloadTaskStore = Pick<
  TaskStore,
  | "claimDownload"
  | "loadVideoOutput"
  | "persistVideoOutputAndComplete"
  | "invalidateVideoOutput"
  | "scheduleDownloadRetry"
  | "stopDownload"
>;

export function createDownloadProcessor(
  dependencies: DownloadProcessorDependencies
) {
  const now = dependencies.now ?? (() => new Date());
  const random = dependencies.random ?? Math.random;
  return async (
    taskId: string,
    providerTaskId: string,
    downloadVersion: number
  ): Promise<void> => {
    const startedAt = now();
    const claim = await dependencies.store.claimDownload(
      taskId,
      providerTaskId,
      downloadVersion,
      startedAt,
      addMilliseconds(startedAt, dependencies.policy.timeoutMs * 3 + 5_000)
    );
    if (claim === null) return;
    if (startedAt >= claim.downloadDeadlineAt) {
      await dependencies.store.stopDownload(
        claim,
        startedAt,
        "DOWNLOAD_DEADLINE_EXCEEDED",
        "Video download deadline exceeded; manual review is required."
      );
      return;
    }

    try {
      const output = await recoverOrDownload(dependencies, claim);
      await dependencies.store.persistVideoOutputAndComplete(
        claim,
        output,
        now()
      );
    } catch (error) {
      await handleDownloadError(dependencies, claim, error, now(), random);
    }
  };
}

async function recoverOrDownload(
  dependencies: DownloadProcessorDependencies,
  claim: DownloadClaim
): Promise<VideoOutputMetadata> {
  const storageKey = outputStorageKey(claim.taskId);
  const recorded = await dependencies.store.loadVideoOutput(claim.taskId);
  if (recorded !== null) {
    const recovered = await inspectRecordedOutput(
      dependencies,
      claim,
      recorded,
      storageKey
    );
    if (recovered !== null) return recovered;
  }

  const existing = await inspectExistingFile(dependencies, storageKey);
  if (existing !== null) return toOutputMetadata(storageKey, existing);

  const download = await withDownloadTimeout(
    dependencies.provider.downloadOutput(claim.providerTaskId, {
      kind: "video"
    }),
    dependencies.policy.timeoutMs
  );
  validateProviderMetadata(download, dependencies.policy.maxBytes);
  const stored = await dependencies.storage.putAtomic(
    storageKey,
    download.body,
    {
      maxBytes: dependencies.policy.maxBytes,
      timeoutMs: dependencies.policy.timeoutMs,
      validate: validateMp4Candidate
    }
  );
  return toOutputMetadata(storageKey, stored);
}

async function inspectRecordedOutput(
  dependencies: DownloadProcessorDependencies,
  claim: DownloadClaim,
  recorded: StoredVideoOutput,
  expectedStorageKey: string
): Promise<VideoOutputMetadata | null> {
  try {
    if (
      recorded.storageKey !== expectedStorageKey ||
      recorded.mimeType !== outputMimeType
    ) {
      throw new DownloadValidationError(
        "DOWNLOAD_METADATA_INCONSISTENT",
        "Stored video metadata is inconsistent."
      );
    }
    const inspected = await dependencies.storage.inspect(recorded.storageKey, {
      maxBytes: dependencies.policy.maxBytes,
      timeoutMs: dependencies.policy.timeoutMs,
      validate: validateMp4Candidate
    });
    if (
      inspected.sha256 !== recorded.sha256 ||
      inspected.sizeBytes !== recorded.fileSize
    ) {
      throw new DownloadValidationError(
        "DOWNLOAD_CHECKSUM_MISMATCH",
        "Stored video metadata does not match the file."
      );
    }
    return toOutputMetadata(recorded.storageKey, inspected);
  } catch (error) {
    if (!isMissingFile(error) && !(error instanceof DownloadValidationError)) {
      if (
        !(error instanceof StorageLimitError) &&
        !(error instanceof ProviderDownloadValidationError)
      ) {
        throw error;
      }
    }
    const invalidatedKey =
      await dependencies.store.invalidateVideoOutput(claim);
    if (invalidatedKey === expectedStorageKey) {
      await dependencies.storage.delete(invalidatedKey).catch(() => undefined);
    }
    return null;
  }
}

async function inspectExistingFile(
  dependencies: DownloadProcessorDependencies,
  storageKey: string
): Promise<{ sizeBytes: number; sha256: string } | null> {
  try {
    return await dependencies.storage.inspect(storageKey, {
      maxBytes: dependencies.policy.maxBytes,
      timeoutMs: dependencies.policy.timeoutMs,
      validate: validateMp4Candidate
    });
  } catch (error) {
    if (isMissingFile(error)) return null;
    if (
      error instanceof DownloadValidationError ||
      error instanceof ProviderDownloadValidationError ||
      error instanceof StorageLimitError
    ) {
      await dependencies.storage.delete(storageKey).catch(() => undefined);
      return null;
    }
    throw error;
  }
}

function validateProviderMetadata(
  download: ProviderDownload,
  maxBytes: number
): void {
  const contentType = download.contentType?.toLowerCase();
  if (contentType !== outputMimeType) {
    download.body.destroy();
    throw new DownloadValidationError(
      "DOWNLOAD_MIME_INVALID",
      "Provider output MIME type is not allowed."
    );
  }
  if (download.contentLength !== undefined) {
    if (!Number.isSafeInteger(download.contentLength)) {
      download.body.destroy();
      throw new DownloadValidationError(
        "DOWNLOAD_LENGTH_INVALID",
        "Provider output Content-Length is invalid."
      );
    }
    if (download.contentLength <= 0) {
      download.body.destroy();
      throw new DownloadValidationError(
        "DOWNLOAD_EMPTY",
        "Provider output is empty."
      );
    }
    if (download.contentLength > maxBytes) {
      download.body.destroy();
      throw new DownloadValidationError(
        "DOWNLOAD_SIZE_LIMIT_EXCEEDED",
        "Provider output exceeds the configured size limit."
      );
    }
  }
}

async function validateMp4Candidate(
  candidate: StorageCandidate
): Promise<void> {
  if (candidate.sizeBytes === 0) {
    throw new DownloadValidationError(
      "DOWNLOAD_EMPTY",
      "Provider output is empty."
    );
  }
  await validateMp4Stream(candidate.openReadStream(), candidate.sizeBytes);
}

export async function validateMp4Stream(
  stream: Readable,
  fileSize: number
): Promise<void> {
  if (!Number.isSafeInteger(fileSize) || fileSize < 24) {
    discardStream(stream);
    throw invalidMp4("Video file is empty or truncated.");
  }
  let pending = Buffer.alloc(0);
  let position = 0;
  let remainingPayload = 0;
  let firstBox = true;
  let foundFtyp = false;
  let foundMoov = false;
  let foundMdat = false;

  try {
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      let data = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      pending = Buffer.alloc(0);
      let offset = 0;
      while (offset < data.length) {
        if (remainingPayload > 0) {
          const consumed = Math.min(remainingPayload, data.length - offset);
          remainingPayload -= consumed;
          position += consumed;
          offset += consumed;
          continue;
        }
        if (data.length - offset < 8) {
          pending = data.subarray(offset);
          break;
        }
        const size32 = data.readUInt32BE(offset);
        const type = data.toString("ascii", offset + 4, offset + 8);
        let headerSize = 8;
        let boxSize = size32;
        if (size32 === 1) {
          if (data.length - offset < 16) {
            pending = data.subarray(offset);
            break;
          }
          const extendedSize = data.readBigUInt64BE(offset + 8);
          if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw invalidMp4("MP4 box size is unsupported.");
          }
          boxSize = Number(extendedSize);
          headerSize = 16;
        } else if (size32 === 0) {
          boxSize = fileSize - position;
        }
        if (boxSize < headerSize || boxSize > fileSize - position) {
          throw invalidMp4("MP4 box is truncated.");
        }
        if (firstBox && type !== "ftyp") {
          throw invalidMp4("MP4 file does not start with an ftyp box.");
        }
        firstBox = false;
        foundFtyp ||= type === "ftyp";
        foundMoov ||= type === "moov";
        foundMdat ||= type === "mdat";
        position += headerSize;
        offset += headerSize;
        remainingPayload = boxSize - headerSize;
      }
      data = Buffer.alloc(0);
    }
  } catch (error) {
    discardStream(stream);
    throw error;
  }

  if (
    pending.length !== 0 ||
    remainingPayload !== 0 ||
    position !== fileSize ||
    !foundFtyp ||
    !foundMoov ||
    !foundMdat
  ) {
    throw invalidMp4("MP4 file is incomplete.");
  }
}

async function handleDownloadError(
  dependencies: DownloadProcessorDependencies,
  claim: DownloadClaim,
  error: unknown,
  currentTime: Date,
  random: () => number
): Promise<void> {
  const classification = classifyDownloadError(error);
  const attemptsAfterFailure = claim.downloadAttempt + 1;
  if (
    classification.retryable &&
    attemptsAfterFailure < dependencies.policy.maxAttempts
  ) {
    const transientErrors = claim.downloadErrors + 1;
    const exponentialDelay = Math.min(
      dependencies.policy.maxRetryIntervalMs,
      dependencies.policy.baseRetryIntervalMs *
        2 ** Math.min(transientErrors - 1, 30)
    );
    const delay = Math.max(
      jitteredDelay(exponentialDelay, dependencies.policy.jitterRatio, random),
      classification.retryAfterMs ?? 0
    );
    const nextDownloadAt = addMilliseconds(currentTime, delay);
    if (nextDownloadAt < claim.downloadDeadlineAt) {
      const updated = await dependencies.store.scheduleDownloadRetry(
        claim,
        currentTime,
        nextDownloadAt,
        classification.code
      );
      if (updated) {
        await dependencies.scheduler
          .scheduleDownload(
            claim.taskId,
            claim.providerTaskId,
            claim.downloadVersion + 1,
            nextDownloadAt
          )
          .catch(() => undefined);
      }
      return;
    }
  }

  const exhausted =
    classification.retryable &&
    attemptsAfterFailure >= dependencies.policy.maxAttempts;
  await dependencies.store.stopDownload(
    claim,
    currentTime,
    exhausted ? "DOWNLOAD_RETRY_EXHAUSTED" : classification.code,
    exhausted
      ? "Video download retry limit reached; manual review is required."
      : classification.safeMessage
  );
}

function classifyDownloadError(error: unknown): {
  code: string;
  retryable: boolean;
  retryAfterMs?: number;
  safeMessage: string;
} {
  if (error instanceof DownloadValidationError) {
    return {
      code: error.code,
      retryable: false,
      safeMessage: error.message
    };
  }
  if (error instanceof StorageLimitError) {
    return {
      code: "DOWNLOAD_SIZE_LIMIT_EXCEEDED",
      retryable: false,
      safeMessage: "Video exceeds the configured size limit."
    };
  }
  if (error instanceof StorageTimeoutError) {
    return {
      code: "DOWNLOAD_TIMEOUT",
      retryable: true,
      safeMessage: "Video download timed out."
    };
  }
  if (error instanceof ProviderOutputExpiredError) {
    return {
      code: error.code,
      retryable: false,
      safeMessage: "Provider output expired; manual review is required."
    };
  }
  if (error instanceof ProviderOperationError) {
    return {
      code: error.code,
      retryable: error.retryable,
      ...(error.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: error.retryAfterMs }),
      safeMessage: error.message
    };
  }
  return {
    code: "DOWNLOAD_TRANSIENT_ERROR",
    retryable: true,
    safeMessage: "Video download temporarily failed."
  };
}

async function withDownloadTimeout(
  promise: Promise<ProviderDownload>,
  timeoutMs: number
): Promise<ProviderDownload> {
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new StorageTimeoutError());
    }, timeoutMs);
    timer.unref();
  });
  promise
    .then((download) => {
      if (timedOut) download.body.destroy();
    })
    .catch(() => undefined);
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function outputStorageKey(taskId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(taskId)) {
    throw new DownloadValidationError(
      "DOWNLOAD_TASK_ID_INVALID",
      "Task ID cannot be used for output storage."
    );
  }
  return `outputs/${taskId}/video.mp4`;
}

function toOutputMetadata(
  storageKey: string,
  stored: { sizeBytes: number; sha256: string }
): VideoOutputMetadata {
  return {
    storageKey,
    sha256: stored.sha256,
    fileSize: stored.sizeBytes,
    mimeType: outputMimeType
  };
}

function invalidMp4(message: string): DownloadValidationError {
  return new DownloadValidationError("DOWNLOAD_MP4_INVALID", message);
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function discardStream(stream: Readable): void {
  stream.on("error", () => undefined);
  stream.destroy();
}

function jitteredDelay(
  delayMs: number,
  jitterRatio: number,
  random: () => number
): number {
  const boundedRandom = Math.min(1, Math.max(0, random()));
  const factor = 1 + (boundedRandom * 2 - 1) * jitterRatio;
  return Math.max(1, Math.round(delayMs * factor));
}

function addMilliseconds(value: Date, milliseconds: number): Date {
  return new Date(value.getTime() + milliseconds);
}

export class DownloadValidationError extends Error {
  constructor(
    readonly code: string,
    safeMessage: string
  ) {
    super(safeMessage);
    this.name = "DownloadValidationError";
  }
}
