import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, type ReadStream } from "node:fs";
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { Transform, Writable, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface StoredObjectInfo {
  sizeBytes: number;
}

export interface ValidatedStoredObjectInfo extends StoredObjectInfo {
  sha256: string;
}

export interface StorageCandidate extends ValidatedStoredObjectInfo {
  openReadStream(): Readable;
}

export interface AtomicWriteOptions {
  maxBytes: number;
  timeoutMs: number;
  validate(candidate: StorageCandidate): Promise<void>;
}

export interface InspectOptions {
  maxBytes: number;
  timeoutMs: number;
  validate(candidate: StorageCandidate): Promise<void>;
}

export interface Storage {
  put(storageKey: string, source: Readable): Promise<StoredObjectInfo>;
  putAtomic(
    storageKey: string,
    source: Readable,
    options: AtomicWriteOptions
  ): Promise<ValidatedStoredObjectInfo>;
  inspect(
    storageKey: string,
    options: InspectOptions
  ): Promise<ValidatedStoredObjectInfo>;
  openReadStream(storageKey: string): Readable;
  stat(storageKey: string): Promise<StoredObjectInfo>;
  delete(storageKey: string): Promise<void>;
}

export class StorageLimitError extends Error {
  readonly code = "STORAGE_SIZE_LIMIT_EXCEEDED";

  constructor() {
    super("Stored object exceeds the configured size limit.");
    this.name = "StorageLimitError";
  }
}

export class StorageTimeoutError extends Error {
  readonly code = "STORAGE_WRITE_TIMEOUT";

  constructor() {
    super("Stored object operation exceeded the configured timeout.");
    this.name = "StorageTimeoutError";
  }
}

export class LocalStorage implements Storage {
  private readonly root: string;
  private readonly temporaryRoot: string;

  constructor(root: string) {
    this.root = resolve(root);
    this.temporaryRoot = resolve(this.root, ".tmp", "downloads");
  }

  async put(storageKey: string, source: Readable): Promise<StoredObjectInfo> {
    const target = this.resolveKey(storageKey);
    await mkdir(dirname(target), { recursive: true });
    await pipeline(source, createWriteStream(target, { flags: "wx" }));
    return this.stat(storageKey);
  }

  async putAtomic(
    storageKey: string,
    source: Readable,
    options: AtomicWriteOptions
  ): Promise<ValidatedStoredObjectInfo> {
    validateOperationOptions(options);
    const target = this.resolveKey(storageKey);
    await mkdir(this.temporaryRoot, { recursive: true });
    const temporaryPath = resolve(
      this.temporaryRoot,
      `${randomUUID()}.partial`
    );
    if (!temporaryPath.startsWith(`${this.temporaryRoot}${sep}`)) {
      throw new Error("Temporary storage path escaped its root.");
    }

    try {
      const result = await writeCandidate(
        temporaryPath,
        source,
        options.maxBytes,
        options.timeoutMs
      );
      await options.validate({
        ...result,
        openReadStream: () => createReadStream(temporaryPath)
      });
      await mkdir(dirname(target), { recursive: true });
      await rename(temporaryPath, target);
      await syncDirectory(dirname(target));
      return result;
    } catch (error) {
      source.destroy();
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  async inspect(
    storageKey: string,
    options: InspectOptions
  ): Promise<ValidatedStoredObjectInfo> {
    validateOperationOptions(options);
    const target = this.resolveKey(storageKey);
    const result = await inspectCandidate(
      target,
      options.maxBytes,
      options.timeoutMs
    );
    await options.validate({
      ...result,
      openReadStream: () => createReadStream(target)
    });
    return result;
  }

  openReadStream(storageKey: string): Readable {
    return createReadStream(this.resolveKey(storageKey));
  }

  async stat(storageKey: string): Promise<StoredObjectInfo> {
    const info = await stat(this.resolveKey(storageKey));
    return { sizeBytes: info.size };
  }

  async delete(storageKey: string): Promise<void> {
    await unlink(this.resolveKey(storageKey));
  }

  private resolveKey(storageKey: string): string {
    if (
      storageKey.length === 0 ||
      storageKey.includes("\0") ||
      storageKey.startsWith("/")
    ) {
      throw new Error("Invalid storage key.");
    }
    const target = resolve(this.root, storageKey);
    if (target !== this.root && !target.startsWith(`${this.root}${sep}`)) {
      throw new Error("Storage key escapes the configured root.");
    }
    return target;
  }
}

async function writeCandidate(
  path: string,
  source: Readable,
  maxBytes: number,
  timeoutMs: number
): Promise<ValidatedStoredObjectInfo> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sizeBytes += chunk.length;
      if (sizeBytes > maxBytes) {
        callback(new StorageLimitError());
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    }
  });
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    source.destroy(new StorageTimeoutError());
  }, timeoutMs);
  timer.unref();
  try {
    await pipeline(
      source,
      limiter,
      createWriteStream(path, { flags: "wx", mode: 0o600 }),
      {
        signal: controller.signal
      }
    );
    const file = await open(path, "r");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  } catch (error) {
    if (timedOut) throw new StorageTimeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return { sizeBytes, sha256: hash.digest("hex") };
}

async function inspectCandidate(
  path: string,
  maxBytes: number,
  timeoutMs: number
): Promise<ValidatedStoredObjectInfo> {
  const fileInfo = await stat(path);
  if (fileInfo.size > maxBytes) throw new StorageLimitError();
  const hash = createHash("sha256");
  let sizeBytes = 0;
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      sizeBytes += chunk.length;
      if (sizeBytes > maxBytes) {
        callback(new StorageLimitError());
        return;
      }
      hash.update(chunk);
      callback();
    }
  });
  await pipelineWithTimeout(createReadStream(path), sink, timeoutMs);
  return { sizeBytes, sha256: hash.digest("hex") };
}

async function pipelineWithTimeout(
  source: ReadStream,
  sink: Writable,
  timeoutMs: number
): Promise<void> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    source.destroy(new StorageTimeoutError());
  }, timeoutMs);
  timer.unref();
  try {
    await pipeline(source, sink, { signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new StorageTimeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function validateOperationOptions(options: {
  maxBytes: number;
  timeoutMs: number;
}): void {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw new Error("Storage maxBytes must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("Storage timeoutMs must be a positive safe integer.");
  }
}
