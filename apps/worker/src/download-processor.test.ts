import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { TaskStatus } from "@prisma/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  ProviderAuthenticationError,
  ProviderOutputExpiredError,
  ProviderRateLimitError,
  ProviderTransientError,
  type ProviderDownload,
  type SeedanceProvider
} from "@seedance/seedance-provider";
import { LocalStorage, type Storage } from "@seedance/storage";

import {
  createDownloadProcessor,
  type DownloadPolicy,
  type DownloadTaskStore
} from "./download-processor.js";
import type { ProviderJobScheduler } from "./job-scheduler.js";
import type {
  DownloadClaim,
  StoredVideoOutput,
  VideoOutputMetadata
} from "./task-store.js";

const fixture = readFileSync(
  fileURLToPath(
    new URL(
      "../../../packages/seedance-provider/fixtures/mock-output.mp4",
      import.meta.url
    )
  )
);
const baseTime = new Date("2026-07-31T00:00:00.000Z");
const policy: DownloadPolicy = {
  maxBytes: fixture.length + 1_024,
  timeoutMs: 2_000,
  baseRetryIntervalMs: 1_000,
  maxRetryIntervalMs: 8_000,
  maxAttempts: 3,
  jitterRatio: 0
};
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("safe provider download processing", () => {
  it("atomically stores a valid MP4 before completing the task", async () => {
    const harness = await createHarness();

    await harness.run();

    expect(harness.provider.downloadCalls).toBe(1);
    expect(harness.store.status).toBe(TaskStatus.SUCCEEDED);
    expect(harness.store.output).toMatchObject({
      storageKey: "outputs/task-1/video.mp4",
      mimeType: "video/mp4",
      fileSize: fixture.length
    });
    expect(harness.store.output?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(
      (await harness.storage.stat("outputs/task-1/video.mp4")).sizeBytes
    ).toBe(fixture.length);
  });

  it("ignores duplicate, stale, and terminal download jobs", async () => {
    const harness = await createHarness();
    await harness.run();
    await harness.run();
    await harness.process("task-1", "provider-task-1", 1);
    harness.store.status = TaskStatus.CANCELLED;
    await harness.process("task-1", "provider-task-1", 2);

    expect(harness.provider.downloadCalls).toBe(1);
    expect(harness.store.persistCalls).toBe(1);
  });

  it("recovers metadata from an existing deterministic file", async () => {
    const harness = await createHarness();
    await writeFixture(harness.storage);

    await harness.run();

    expect(harness.provider.downloadCalls).toBe(0);
    expect(harness.store.status).toBe(TaskStatus.SUCCEEDED);
    expect(harness.store.output?.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("completes from an existing VideoOutput without downloading", async () => {
    const harness = await createHarness();
    const stored = await writeFixture(harness.storage);
    harness.store.output = {
      assetId: "asset-1",
      storageKey: "outputs/task-1/video.mp4",
      sha256: stored.sha256,
      fileSize: stored.sizeBytes,
      mimeType: "video/mp4"
    };

    await harness.run();

    expect(harness.provider.downloadCalls).toBe(0);
    expect(harness.store.status).toBe(TaskStatus.SUCCEEDED);
  });

  it("reuses an atomically committed file after a database failure", async () => {
    const harness = await createHarness();
    harness.store.failPersistOnce = true;

    await harness.run();
    expect(harness.provider.downloadCalls).toBe(1);
    expect(harness.store.downloadVersion).toBe(2);
    harness.setNow(harness.store.nextDownloadAt as Date);
    await harness.run();

    expect(harness.provider.downloadCalls).toBe(1);
    expect(harness.store.status).toBe(TaskStatus.SUCCEEDED);
  });

  it("repairs a missing file behind an existing VideoOutput", async () => {
    const harness = await createHarness();
    harness.store.output = {
      assetId: "asset-1",
      storageKey: "outputs/task-1/video.mp4",
      sha256: "0".repeat(64),
      fileSize: fixture.length,
      mimeType: "video/mp4"
    };

    await harness.run();

    expect(harness.store.invalidateCalls).toBe(1);
    expect(harness.provider.downloadCalls).toBe(1);
    expect(harness.store.status).toBe(TaskStatus.SUCCEEDED);
  });

  it("cleans its temporary file when the stream is interrupted", async () => {
    const interrupted = new Readable({
      read() {
        this.push(fixture.subarray(0, 128));
        this.destroy(new Error("fixture connection interrupted"));
      }
    });
    const harness = await createHarness({
      downloads: [
        {
          body: interrupted,
          contentType: "video/mp4"
        }
      ]
    });

    await harness.run();

    expect(harness.store.downloadVersion).toBe(2);
    await expect(
      harness.storage.stat("outputs/task-1/video.mp4")
    ).rejects.toMatchObject({ code: "ENOENT" });
    const temporaryDirectory = join(harness.root, ".tmp", "downloads");
    expect(await readdir(temporaryDirectory)).toEqual([]);
  });

  it("times out a provider response and schedules a bounded retry", async () => {
    const neverResponds = new Promise<ProviderDownload>(() => undefined);
    const harness = await createHarness({
      downloads: [neverResponds],
      policy: { ...policy, timeoutMs: 10 }
    });

    await harness.run();

    expect(harness.store.lastError).toBe("DOWNLOAD_TIMEOUT");
    expect(harness.store.downloadVersion).toBe(2);
    expect(harness.scheduler.downloads).toHaveLength(1);
  });

  it("rejects an oversized Content-Length before reading", async () => {
    const body = Readable.from(fixture);
    const harness = await createHarness({
      downloads: [
        {
          body,
          contentType: "video/mp4",
          contentLength: policy.maxBytes + 1
        }
      ]
    });

    await harness.run();

    expect(body.destroyed).toBe(true);
    expect(harness.store.lastError).toBe("DOWNLOAD_SIZE_LIMIT_EXCEEDED");
    expect(harness.scheduler.downloads).toEqual([]);
  });

  it("stops a stream that exceeds the configured maximum", async () => {
    const harness = await createHarness({
      policy: { ...policy, maxBytes: 64 },
      downloads: [
        {
          body: Readable.from(fixture),
          contentType: "video/mp4"
        }
      ]
    });

    await harness.run();

    expect(harness.store.lastError).toBe("DOWNLOAD_SIZE_LIMIT_EXCEEDED");
    await expect(
      harness.storage.stat("outputs/task-1/video.mp4")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an unsupported MIME type", async () => {
    const harness = await createHarness({
      downloads: [
        {
          body: Readable.from(fixture),
          contentType: "application/octet-stream",
          contentLength: fixture.length
        }
      ]
    });

    await harness.run();

    expect(harness.store.lastError).toBe("DOWNLOAD_MIME_INVALID");
    expect(harness.store.status).toBe(TaskStatus.PROCESSING);
  });

  it.each([
    ["invalid signature", Buffer.from("not-an-mp4"), "DOWNLOAD_MP4_INVALID"],
    ["empty", Buffer.alloc(0), "DOWNLOAD_EMPTY"],
    [
      "truncated",
      fixture.subarray(0, Math.floor(fixture.length / 2)),
      "DOWNLOAD_MP4_INVALID"
    ]
  ])("rejects %s output", async (_name, bytes, expectedCode) => {
    const harness = await createHarness({
      downloads: [
        {
          body: Readable.from(bytes),
          contentType: "video/mp4",
          contentLength: bytes.length
        }
      ]
    });

    await harness.run();

    expect(harness.store.lastError).toBe(expectedCode);
    expect(harness.store.output).toBeNull();
  });

  it.each([
    new ProviderRateLimitError("DOWNLOAD", "SAFE_READ", 5_000),
    new ProviderTransientError("DOWNLOAD", { statusCode: 503 })
  ])("reschedules retryable Provider errors", async (error) => {
    const harness = await createHarness({ downloads: [error] });

    await harness.run();

    expect(harness.store.downloadVersion).toBe(2);
    expect(harness.scheduler.downloads).toHaveLength(1);
    expect(harness.scheduler.downloads[0]?.downloadVersion).toBe(2);
  });

  it.each([401, 403])(
    "does not retry authentication error %s",
    async (statusCode) => {
      const harness = await createHarness({
        downloads: [new ProviderAuthenticationError("DOWNLOAD", statusCode)]
      });

      await harness.run();

      expect(harness.store.lastError).toBe("PROVIDER_AUTHENTICATION_FAILED");
      expect(harness.scheduler.downloads).toEqual([]);
    }
  );

  it("stops on an expired Provider output", async () => {
    const harness = await createHarness({
      downloads: [new ProviderOutputExpiredError()]
    });

    await harness.run();

    expect(harness.store.lastError).toBe("PROVIDER_OUTPUT_EXPIRED");
    expect(harness.scheduler.downloads).toEqual([]);
  });

  it("stops after the configured retry limit", async () => {
    const harness = await createHarness({
      downloads: [new ProviderTransientError("DOWNLOAD", { statusCode: 503 })]
    });
    harness.store.downloadAttempt = policy.maxAttempts - 1;

    await harness.run();

    expect(harness.store.lastError).toBe("DOWNLOAD_RETRY_EXHAUSTED");
    expect(harness.scheduler.downloads).toEqual([]);
  });

  it("does not overwrite cancellation that wins during download", async () => {
    const harness = await createHarness();
    harness.provider.beforeStreamEnd = () => {
      harness.store.status = TaskStatus.CANCELLED;
    };

    await harness.run();

    expect(harness.store.status).toBe(TaskStatus.CANCELLED);
    expect(harness.store.output).toBeNull();
    expect(harness.store.persistCalls).toBe(1);
  });

  it("stops immediately at the persisted download deadline", async () => {
    const harness = await createHarness();
    harness.setNow(harness.store.downloadDeadlineAt);

    await harness.process("task-1", "provider-task-1", 1);

    expect(harness.provider.downloadCalls).toBe(0);
    expect(harness.store.lastError).toBe("DOWNLOAD_DEADLINE_EXCEEDED");
  });
});

async function createHarness(
  options: {
    downloads?: Array<ProviderDownload | Error | Promise<ProviderDownload>>;
    policy?: DownloadPolicy;
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), "seedance-download-"));
  temporaryRoots.push(root);
  const storage = new LocalStorage(root);
  const store = new MemoryDownloadStore();
  const provider = new FixtureProvider(options.downloads ?? []);
  const scheduler = new MemoryScheduler();
  let currentTime = new Date(baseTime);
  const dependencies = {
    store,
    provider: provider as unknown as SeedanceProvider,
    storage,
    scheduler,
    policy: options.policy ?? policy,
    now: () => new Date(currentTime),
    random: () => 0.5
  };
  const process = createDownloadProcessor(dependencies);
  return {
    root,
    storage,
    store,
    provider,
    scheduler,
    process,
    setNow(value: Date) {
      currentTime = new Date(value);
    },
    run() {
      currentTime = new Date(store.nextDownloadAt ?? currentTime);
      return process("task-1", "provider-task-1", store.downloadVersion);
    }
  };
}

class MemoryDownloadStore implements DownloadTaskStore {
  status = TaskStatus.PROCESSING;
  downloadPending = true;
  downloadVersion = 1;
  downloadAttempt = 0;
  downloadErrors = 0;
  nextDownloadAt: Date | null = new Date(baseTime);
  downloadDeadlineAt = new Date(baseTime.getTime() + 60_000);
  leaseUntil: Date | null = null;
  output: StoredVideoOutput | null = null;
  lastError: string | null = null;
  failPersistOnce = false;
  persistCalls = 0;
  invalidateCalls = 0;

  async claimDownload(
    taskId: string,
    providerTaskId: string,
    downloadVersion: number,
    now: Date,
    leaseUntil: Date
  ): Promise<DownloadClaim | null> {
    if (
      taskId !== "task-1" ||
      providerTaskId !== "provider-task-1" ||
      this.status !== TaskStatus.PROCESSING ||
      !this.downloadPending ||
      this.downloadVersion !== downloadVersion ||
      this.nextDownloadAt === null ||
      this.nextDownloadAt > now ||
      (this.leaseUntil !== null && this.leaseUntil > now)
    ) {
      return null;
    }
    this.leaseUntil = leaseUntil;
    return this.claim();
  }

  async loadVideoOutput(): Promise<StoredVideoOutput | null> {
    return this.output;
  }

  async persistVideoOutputAndComplete(
    claim: DownloadClaim,
    output: VideoOutputMetadata
  ): Promise<boolean> {
    this.persistCalls += 1;
    if (this.failPersistOnce) {
      this.failPersistOnce = false;
      throw new Error("fixture database unavailable");
    }
    if (!this.isCurrent(claim)) return false;
    this.output = { ...output, assetId: "asset-1" };
    this.status = TaskStatus.SUCCEEDED;
    this.downloadPending = false;
    this.nextDownloadAt = null;
    this.leaseUntil = null;
    return true;
  }

  async invalidateVideoOutput(claim: DownloadClaim): Promise<string | null> {
    if (!this.isCurrent(claim) || this.output === null) return null;
    this.invalidateCalls += 1;
    const storageKey = this.output.storageKey;
    this.output = null;
    return storageKey;
  }

  async scheduleDownloadRetry(
    claim: DownloadClaim,
    _now: Date,
    nextDownloadAt: Date,
    errorCode: string
  ): Promise<boolean> {
    if (!this.isCurrent(claim)) return false;
    this.downloadVersion += 1;
    this.downloadAttempt += 1;
    this.downloadErrors += 1;
    this.nextDownloadAt = nextDownloadAt;
    this.leaseUntil = null;
    this.lastError = errorCode;
    return true;
  }

  async stopDownload(
    claim: DownloadClaim,
    _now: Date,
    errorCode: string
  ): Promise<boolean> {
    if (!this.isCurrent(claim)) return false;
    this.downloadAttempt += 1;
    this.nextDownloadAt = null;
    this.leaseUntil = null;
    this.lastError = errorCode;
    return true;
  }

  private claim(): DownloadClaim {
    return {
      taskId: "task-1",
      providerTaskId: "provider-task-1",
      downloadVersion: this.downloadVersion,
      downloadAttempt: this.downloadAttempt,
      downloadErrors: this.downloadErrors,
      downloadDeadlineAt: this.downloadDeadlineAt,
      leaseUntil: this.leaseUntil as Date
    };
  }

  private isCurrent(claim: DownloadClaim): boolean {
    return (
      this.status === TaskStatus.PROCESSING &&
      this.downloadPending &&
      this.downloadVersion === claim.downloadVersion &&
      this.leaseUntil?.getTime() === claim.leaseUntil.getTime()
    );
  }
}

class FixtureProvider {
  downloadCalls = 0;
  beforeStreamEnd?: () => void;
  private readonly downloads: Array<
    ProviderDownload | Error | Promise<ProviderDownload>
  >;

  constructor(
    downloads: Array<ProviderDownload | Error | Promise<ProviderDownload>>
  ) {
    this.downloads = [...downloads];
  }

  async downloadOutput(): Promise<ProviderDownload> {
    this.downloadCalls += 1;
    const value = this.downloads.shift();
    if (value instanceof Error) throw value;
    if (value !== undefined) return value;
    const beforeStreamEnd = this.beforeStreamEnd;
    return {
      body: Readable.from(
        (async function* () {
          const midpoint = Math.floor(fixture.length / 2);
          yield fixture.subarray(0, midpoint);
          beforeStreamEnd?.();
          yield fixture.subarray(midpoint);
        })()
      ),
      contentType: "video/mp4",
      contentLength: fixture.length
    };
  }
}

class MemoryScheduler implements ProviderJobScheduler {
  readonly downloads: {
    taskId: string;
    providerTaskId: string;
    downloadVersion: number;
    runAt: Date;
  }[] = [];

  async schedulePoll(): Promise<void> {}

  async scheduleDownload(
    taskId: string,
    providerTaskId: string,
    downloadVersion: number,
    runAt: Date
  ): Promise<void> {
    this.downloads.push({
      taskId,
      providerTaskId,
      downloadVersion,
      runAt
    });
  }
}

async function writeFixture(
  storage: Storage
): Promise<{ sizeBytes: number; sha256: string }> {
  return storage.putAtomic("outputs/task-1/video.mp4", Readable.from(fixture), {
    maxBytes: policy.maxBytes,
    timeoutMs: policy.timeoutMs,
    validate: async () => undefined
  });
}
