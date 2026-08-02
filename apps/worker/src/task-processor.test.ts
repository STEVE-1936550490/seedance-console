import { Readable } from "node:stream";

import { TaskStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  ProviderAuthenticationError,
  ProviderCreateNotSentError,
  ProviderOutcomeUnknownError,
  ProviderProtocolError,
  ProviderRateLimitError,
  ProviderRequestError,
  ProviderTransientError,
  type CreateTaskInput,
  type ProviderCapabilities,
  type ProviderCreateAudit,
  type ProviderDownload,
  type ProviderTaskSnapshot,
  type ProviderUsage,
  type SeedanceProvider,
  type ValidationResult
} from "@seedance/seedance-provider";
import type { AssetPublisher, PublishedRemoteObject } from "@seedance/storage";

import type { ProviderJobScheduler } from "./job-scheduler.js";
import { createPollCoordinator } from "./poll-coordinator.js";
import type {
  DownloadClaim,
  DownloadSchedule,
  InitialPollSchedule,
  NextPollSchedule,
  PollClaim,
  RecoverablePoll,
  SubmissionTask,
  TaskStore
} from "./task-store.js";
import {
  cleanupPublishedAssets,
  createPollProcessor,
  createSubmitProcessor,
  type PollingPolicy
} from "./task-processor.js";

const baseTime = new Date("2026-07-31T00:00:00.000Z");
const policy: PollingPolicy = {
  baseIntervalMs: 1_000,
  maxIntervalMs: 8_000,
  maxDurationMs: 60_000,
  requestTimeoutMs: 5_000,
  jitterRatio: 0.1,
  downloadMaxDurationMs: 60_000
};

describe("split Provider submit and poll processing", () => {
  it("submit persists the first schedule and only enqueues a poll", async () => {
    const harness = createHarness();

    await harness.submit("task-1");

    expect(harness.provider.createCalls).toBe(1);
    expect(harness.provider.getCalls).toBe(0);
    expect(harness.store.task.status).toBe(TaskStatus.PROCESSING);
    expect(harness.store.task.pollVersion).toBe(1);
    expect(harness.scheduler.polls).toEqual([
      {
        taskId: "task-1",
        pollVersion: 1,
        runAt: new Date("2026-07-31T00:00:01.000Z")
      }
    ]);
    expect(harness.scheduler.downloads).toEqual([]);
  });

  it("publishes a reference image in memory before a Seedance create", async () => {
    const publishedAt = new Date(baseTime.getTime() + 120_000);
    const assetPublisher: AssetPublisher = {
      publishForProvider: async (input) => ({
        assetId: input.assetId,
        role: "REFERENCE_IMAGE",
        mimeType: "image/png",
        sizeBytes: 128,
        checksum: "a".repeat(64),
        url: "https://assets.example.com/api/provider-assets/asset-one?signed=redacted",
        expiresAt: publishedAt
      }),
      authorizeProviderAsset: async () => {
        throw new Error("Not used by the Worker.");
      }
    };
    const harness = createHarness({
      providerName: "seedance",
      assetPublisher
    });
    harness.store.task.provider = "seedance";
    harness.store.task.referenceAssetIds = ["asset-one"];

    await harness.submit("task-1");

    expect(harness.provider.lastCreateInput?.publishedAssets).toEqual([
      {
        assetId: "asset-one",
        role: "REFERENCE_IMAGE",
        position: 0,
        mimeType: "image/png",
        sizeBytes: 128,
        checksum: "a".repeat(64),
        url: "https://assets.example.com/api/provider-assets/asset-one?signed=redacted",
        expiresAt: publishedAt
      }
    ]);
  });

  it("publishes one reference video with the audited purpose before create", async () => {
    const purposes: string[] = [];
    const assetPublisher: AssetPublisher = {
      publishForProvider: async (input) => {
        purposes.push(input.purpose);
        return {
          assetId: input.assetId,
          role: "REFERENCE_VIDEO",
          mimeType: "video/mp4",
          sizeBytes: 7_309_809,
          checksum: "b".repeat(64),
          url: "https://objects.example.com/video.mp4?signature=redacted",
          expiresAt: new Date(baseTime.getTime() + 120_000),
          metadata: {
            container: "mp4",
            durationSeconds: 11.041667,
            width: 1280,
            height: 720,
            codec: "h264",
            pixelFormat: "yuv420p",
            frameRate: "24/1",
            hasAudio: false
          }
        };
      },
      authorizeProviderAsset: async () => {
        throw new Error("not used");
      }
    };
    const harness = createHarness({ providerName: "seedance", assetPublisher });
    harness.store.task.provider = "seedance";
    harness.store.task.referenceAssetIds = ["video-one"];
    harness.store.task.referenceAssetRoles = ["REFERENCE_VIDEO"];

    await harness.submit("task-1");

    expect(purposes).toEqual(["reference-video"]);
    expect(
      harness.provider.lastCreateInput?.publishedAssets?.[0]
    ).toMatchObject({
      role: "REFERENCE_VIDEO",
      mimeType: "video/mp4",
      metadata: { durationSeconds: 11.041667 }
    });
  });

  it("does not call the Provider when object upload fails", async () => {
    const assetPublisher: AssetPublisher = {
      publishForProvider: async () => {
        throw new Error("fixture upload failure");
      },
      authorizeProviderAsset: async () => {
        throw new Error("not used");
      }
    };
    const harness = createHarness({ providerName: "seedance", assetPublisher });
    harness.store.task.provider = "seedance";
    harness.store.task.referenceAssetIds = ["asset-one"];

    await harness.submit("task-1");

    expect(harness.provider.createCalls).toBe(0);
    expect(harness.store.task.status).toBe(TaskStatus.FAILED);
  });

  it("cleans up an object when Provider create fails", async () => {
    const deleted: PublishedRemoteObject[] = [];
    const remoteObject: PublishedRemoteObject = {
      publisher: "eos",
      bucket: "private-bucket",
      objectKey: "seedance-inputs/redacted-object"
    };
    const assetPublisher: AssetPublisher = {
      publishForProvider: async (input) => ({
        assetId: input.assetId,
        role: "REFERENCE_IMAGE",
        mimeType: "image/png",
        sizeBytes: 128,
        checksum: "a".repeat(64),
        url: "https://objects.example.com/private?signature=redacted",
        expiresAt: new Date(baseTime.getTime() + 120_000),
        remoteObject
      }),
      authorizeProviderAsset: async () => {
        throw new Error("not used");
      },
      deletePublishedAsset: async (value) => {
        deleted.push(value);
      }
    };
    const harness = createHarness({
      providerName: "seedance",
      assetPublisher,
      createError: new ProviderRequestError("CREATE", 400)
    });
    harness.store.task.provider = "seedance";
    harness.store.task.referenceAssetIds = ["asset-one"];

    await harness.submit("task-1");

    expect(deleted).toContainEqual(remoteObject);
    expect(harness.store.task.status).toBe(TaskStatus.FAILED);
  });

  it("cleans up a bound object after a Provider terminal failure", async () => {
    const deleted: PublishedRemoteObject[] = [];
    const remoteObject: PublishedRemoteObject = {
      publisher: "eos",
      bucket: "private-bucket",
      objectKey: "seedance-inputs/redacted-object"
    };
    const assetPublisher: AssetPublisher = {
      publishForProvider: async (input) => ({
        assetId: input.assetId,
        role: "REFERENCE_IMAGE",
        mimeType: "image/png",
        sizeBytes: 128,
        checksum: "a".repeat(64),
        url: "https://objects.example.com/private?signature=redacted",
        expiresAt: new Date(baseTime.getTime() + 120_000),
        remoteObject
      }),
      authorizeProviderAsset: async () => {
        throw new Error("not used");
      },
      deletePublishedAsset: async (value) => {
        deleted.push(value);
      }
    };
    const harness = createHarness({
      providerName: "seedance",
      assetPublisher,
      snapshots: [failedSnapshot()]
    });
    harness.store.task.provider = "seedance";
    harness.store.task.referenceAssetIds = ["asset-one"];
    await harness.submit("task-1");
    await runCurrentPoll(harness);

    expect(deleted).toContainEqual(remoteObject);
    expect(harness.store.task.status).toBe(TaskStatus.FAILED);
  });

  it("cleans up bound objects after Provider cancelled or expired results", async () => {
    for (const status of ["CANCELLED", "EXPIRED"] as const) {
      const deleted: PublishedRemoteObject[] = [];
      const remoteObject: PublishedRemoteObject = {
        publisher: "eos",
        bucket: "private-bucket",
        objectKey: `seedance-inputs/redacted-${status.toLowerCase()}-object`
      };
      const assetPublisher: AssetPublisher = {
        publishForProvider: async (input) => ({
          assetId: input.assetId,
          role: "REFERENCE_VIDEO",
          mimeType: "video/mp4",
          sizeBytes: 7_309_809,
          checksum: "b".repeat(64),
          url: "https://objects.example.com/video.mp4?signature=redacted",
          expiresAt: new Date(baseTime.getTime() + 120_000),
          remoteObject,
          metadata: {
            container: "mp4",
            durationSeconds: 11.041667,
            width: 1280,
            height: 720,
            codec: "h264",
            pixelFormat: "yuv420p",
            frameRate: "24/1",
            hasAudio: false
          }
        }),
        authorizeProviderAsset: async () => {
          throw new Error("not used");
        },
        deletePublishedAsset: async (value) => {
          deleted.push(value);
        }
      };
      const snapshot: ProviderTaskSnapshot = {
        providerTaskId: "provider-task-1",
        status,
        outputs: [],
        usage: []
      };
      const harness = createHarness({
        providerName: "seedance",
        assetPublisher,
        snapshots: [snapshot]
      });
      harness.store.task.provider = "seedance";
      harness.store.task.referenceAssetIds = ["video-one"];
      harness.store.task.referenceAssetRoles = ["REFERENCE_VIDEO"];

      await harness.submit("task-1");
      await runCurrentPoll(harness);

      expect(deleted).toContainEqual(remoteObject);
      expect(harness.store.task.nextPollAt).toBeNull();
    }
  });

  it("keeps the terminal task result when object cleanup fails", async () => {
    const remoteObject: PublishedRemoteObject = {
      publisher: "eos",
      bucket: "private-bucket",
      objectKey: "seedance-inputs/redacted-object"
    };
    const assetPublisher: AssetPublisher = {
      publishForProvider: async (input) => ({
        assetId: input.assetId,
        role: "REFERENCE_IMAGE",
        mimeType: "image/png",
        sizeBytes: 128,
        checksum: "a".repeat(64),
        url: "https://objects.example.com/private?signature=redacted",
        expiresAt: new Date(baseTime.getTime() + 120_000),
        remoteObject
      }),
      authorizeProviderAsset: async () => {
        throw new Error("not used");
      },
      deletePublishedAsset: async () => {
        throw new Error("secret vendor details must not be persisted");
      }
    };
    const harness = createHarness({
      providerName: "seedance",
      assetPublisher,
      snapshots: [failedSnapshot()]
    });
    harness.store.task.provider = "seedance";
    harness.store.task.referenceAssetIds = ["asset-one"];
    await harness.submit("task-1");
    await runCurrentPoll(harness);

    expect(harness.store.task.status).toBe(TaskStatus.FAILED);
    expect(harness.store.cleanupErrors).toEqual(["OBJECT_DELETE_FAILED"]);
    expect(harness.store.cleanupErrors.join(" ")).not.toContain(
      "secret vendor details"
    );
  });

  it("does not invoke an EOS publisher in mock mode", async () => {
    let publishes = 0;
    const assetPublisher: AssetPublisher = {
      publishForProvider: async () => {
        publishes += 1;
        throw new Error("must not run");
      },
      authorizeProviderAsset: async () => {
        throw new Error("not used");
      }
    };
    const harness = createHarness({ assetPublisher });
    harness.store.task.referenceAssetIds = ["asset-one"];
    await harness.submit("task-1");
    expect(publishes).toBe(0);
    expect(harness.provider.createCalls).toBe(1);
  });

  it("allows only one concurrent submit job to create a Provider task", async () => {
    const harness = createHarness();

    await Promise.all([harness.submit("task-1"), harness.submit("task-1")]);

    expect(harness.provider.createCalls).toBe(1);
    expect(harness.store.task.status).toBe(TaskStatus.PROCESSING);
    expect(harness.scheduler.polls).toHaveLength(1);
  });

  it("recovers a submitting task without calling create again", async () => {
    const harness = createHarness({ recoveredId: "provider-task-recovered" });
    harness.store.task.status = TaskStatus.SUBMITTING;

    await harness.submit("task-1");

    expect(harness.provider.createCalls).toBe(0);
    expect(harness.provider.recoverCalls).toBe(1);
    expect(harness.store.task.providerTaskId).toBe("provider-task-recovered");
    expect(harness.scheduler.polls).toHaveLength(1);
  });

  it("moves an unknown create outcome to reconciliation without retrying", async () => {
    const harness = createHarness({
      createError: new ProviderOutcomeUnknownError()
    });

    await harness.submit("task-1");

    expect(harness.provider.createCalls).toBe(1);
    expect(harness.provider.recoverCalls).toBe(1);
    expect(harness.store.task.status).toBe(TaskStatus.RECONCILIATION_REQUIRED);
    expect(harness.store.task.errorCode).toBe(
      "PROVIDER_CREATE_OUTCOME_UNKNOWN"
    );
    expect(harness.scheduler.polls).toEqual([]);
  });

  it("retains the EOS object and audit after a read timeout", async () => {
    const deleted: PublishedRemoteObject[] = [];
    const remoteObject: PublishedRemoteObject = {
      publisher: "eos",
      bucket: "private-bucket",
      objectKey: `seedance-inputs/videos/${"a".repeat(64)}`
    };
    const assetPublisher: AssetPublisher = {
      publishForProvider: async (input) => ({
        assetId: input.assetId,
        role: "REFERENCE_VIDEO",
        mimeType: "video/mp4",
        sizeBytes: 128,
        checksum: "b".repeat(64),
        url: "https://objects.example.com/video.mp4?signature=redacted",
        expiresAt: new Date(baseTime.getTime() + 120_000),
        remoteObject
      }),
      authorizeProviderAsset: async () => {
        throw new Error("not used");
      },
      deletePublishedAsset: async (object) => {
        deleted.push(object);
      }
    };
    const audit: ProviderCreateAudit = {
      bridgeRequestId: "bridge-request-1",
      failureStage: "READ_RESPONSE",
      exceptionType: "ReadTimeout",
      requestBodySent: true,
      providerRequestId: "provider-request-1"
    };
    const harness = createHarness({
      providerName: "seedance",
      assetPublisher,
      createError: new ProviderOutcomeUnknownError(undefined, audit)
    });
    harness.store.task.provider = "seedance";
    harness.store.task.referenceAssetIds = ["video-one"];
    harness.store.task.referenceAssetRoles = ["REFERENCE_VIDEO"];

    await harness.submit("task-1");

    expect(harness.provider.createCalls).toBe(1);
    expect(harness.store.task.status).toBe(TaskStatus.RECONCILIATION_REQUIRED);
    expect(deleted).toEqual([]);
    expect(harness.store.publishedAssets).toEqual([remoteObject]);
    expect(harness.store.outcomeAudit).toEqual(audit);
  });

  it("cleans EOS after a confirmed not-sent create failure", async () => {
    const deleted: PublishedRemoteObject[] = [];
    const remoteObject: PublishedRemoteObject = {
      publisher: "eos",
      bucket: "private-bucket",
      objectKey: `seedance-inputs/videos/${"c".repeat(64)}`
    };
    const assetPublisher: AssetPublisher = {
      publishForProvider: async (input) => ({
        assetId: input.assetId,
        role: "REFERENCE_VIDEO",
        mimeType: "video/mp4",
        sizeBytes: 128,
        checksum: "d".repeat(64),
        url: "https://objects.example.com/video.mp4?signature=redacted",
        expiresAt: new Date(baseTime.getTime() + 120_000),
        remoteObject
      }),
      authorizeProviderAsset: async () => {
        throw new Error("not used");
      },
      deletePublishedAsset: async (object) => {
        deleted.push(object);
      }
    };
    const harness = createHarness({
      providerName: "seedance",
      assetPublisher,
      createError: new ProviderCreateNotSentError()
    });
    harness.store.task.provider = "seedance";
    harness.store.task.referenceAssetIds = ["video-one"];
    harness.store.task.referenceAssetRoles = ["REFERENCE_VIDEO"];

    await harness.submit("task-1");

    expect(harness.store.task.status).toBe(TaskStatus.FAILED);
    expect(deleted).toEqual([remoteObject]);
  });

  it("keeps EOS after create acceptance while the first poll is pending", async () => {
    const deleted: PublishedRemoteObject[] = [];
    const assetPublisher = referenceVideoPublisher(deleted);
    const harness = createHarness({
      providerName: "seedance",
      assetPublisher
    });
    harness.store.task.provider = "seedance";
    harness.store.task.referenceAssetIds = ["video-one"];
    harness.store.task.referenceAssetRoles = ["REFERENCE_VIDEO"];

    await harness.submit("task-1");
    await cleanupPublishedAssets(
      { store: harness.store, assetPublisher },
      "task-1"
    );

    expect(harness.store.task.status).toBe(TaskStatus.PROCESSING);
    expect(harness.store.task.providerTaskId).toBe("provider-task-1");
    expect(deleted).toEqual([]);
    expect(harness.store.publishedAssets).toHaveLength(1);
  });

  it("recovers an accepted create after local response parsing fails without cleanup", async () => {
    const deleted: PublishedRemoteObject[] = [];
    const assetPublisher = referenceVideoPublisher(deleted);
    const harness = createHarness({
      providerName: "seedance",
      assetPublisher,
      createError: new ProviderProtocolError(
        "CREATE",
        "Bridge response timestamp is invalid."
      ),
      recoveredId: "provider-task-recovered"
    });
    harness.store.task.provider = "seedance";
    harness.store.task.referenceAssetIds = ["video-one"];
    harness.store.task.referenceAssetRoles = ["REFERENCE_VIDEO"];

    await harness.submit("task-1");

    expect(harness.provider.createCalls).toBe(1);
    expect(harness.provider.recoverCalls).toBe(1);
    expect(harness.store.task.status).toBe(TaskStatus.PROCESSING);
    expect(harness.store.task.providerTaskId).toBe("provider-task-recovered");
    expect(deleted).toEqual([]);
  });

  it("makes repeated concurrent EOS cleanup idempotent", async () => {
    const deleted: PublishedRemoteObject[] = [];
    const assetPublisher = referenceVideoPublisher(deleted);
    const harness = createHarness({
      providerName: "seedance",
      assetPublisher
    });
    harness.store.task.provider = "seedance";
    harness.store.task.referenceAssetIds = ["video-one"];
    harness.store.task.referenceAssetRoles = ["REFERENCE_VIDEO"];
    await harness.submit("task-1");
    harness.store.task.status = TaskStatus.FAILED;
    harness.store.task.cleanupReady = true;

    await Promise.all([
      cleanupPublishedAssets(
        { store: harness.store, assetPublisher },
        "task-1"
      ),
      cleanupPublishedAssets({ store: harness.store, assetPublisher }, "task-1")
    ]);

    expect(harness.store.task.status).toBe(TaskStatus.FAILED);
    expect(harness.store.publishedAssets).toEqual([]);
    expect(deleted.length).toBeGreaterThanOrEqual(1);
  });

  it("retries only persistence after Provider acceptance", async () => {
    const harness = createHarness({ failAcceptanceOnce: true });

    await expect(harness.submit("task-1")).rejects.toThrow(
      "Simulated database outage."
    );
    await harness.submit("task-1");

    expect(harness.provider.createCalls).toBe(1);
    expect(harness.provider.recoverCalls).toBe(1);
    expect(harness.store.task.status).toBe(TaskStatus.PROCESSING);
    expect(harness.store.task.providerTaskId).toBe("provider-task-1");
  });

  it("moves pending to running to output-ready without marking succeeded", async () => {
    const harness = createHarness({
      snapshots: [
        processingSnapshot("pending"),
        processingSnapshot("running"),
        succeededSnapshot()
      ]
    });
    await harness.submit("task-1");

    await runCurrentPoll(harness);
    await runCurrentPoll(harness);
    await runCurrentPoll(harness);

    expect(harness.provider.getCalls).toBe(3);
    expect(harness.store.task.status).toBe(TaskStatus.PROCESSING);
    expect(harness.store.task.downloadPending).toBe(true);
    expect(harness.store.task.nextPollAt).toBeNull();
    expect(harness.scheduler.downloads).toEqual(["task-1"]);
  });

  it("stops polling after a Provider failure", async () => {
    const harness = createHarness({ snapshots: [failedSnapshot()] });
    await harness.submit("task-1");
    await runCurrentPoll(harness);

    expect(harness.store.task.status).toBe(TaskStatus.FAILED);
    expect(harness.store.task.nextPollAt).toBeNull();
    expect(harness.scheduler.polls).toHaveLength(1);
  });

  it("backs off after 429 and respects Retry-After", async () => {
    const harness = createHarness({
      snapshots: [new ProviderRateLimitError("GET", "SAFE_READ", 5_000)]
    });
    await harness.submit("task-1");
    harness.setNow(new Date("2026-07-31T00:00:01.000Z"));
    await runCurrentPoll(harness);

    expect(harness.store.task.pollTransientErrors).toBe(1);
    expect(harness.store.task.nextPollAt).toEqual(
      new Date("2026-07-31T00:00:06.000Z")
    );
  });

  it("backs off exponentially after retryable 5xx errors", async () => {
    const harness = createHarness({
      snapshots: [
        new ProviderTransientError("GET", { statusCode: 503 }),
        new ProviderTransientError("GET", { statusCode: 503 })
      ]
    });
    await harness.submit("task-1");
    harness.setNow(new Date("2026-07-31T00:00:01.000Z"));
    await runCurrentPoll(harness);
    expect(delayFrom(harness.now(), harness.store.task.nextPollAt)).toBe(2_000);

    harness.setNow(harness.store.task.nextPollAt as Date);
    await runCurrentPoll(harness);
    expect(delayFrom(harness.now(), harness.store.task.nextPollAt)).toBe(4_000);
  });

  it.each([401, 403])(
    "stops automatic polling on authentication error %s",
    async (statusCode) => {
      const harness = createHarness({
        snapshots: [new ProviderAuthenticationError("GET", statusCode)]
      });
      await harness.submit("task-1");
      await runCurrentPoll(harness);

      expect(harness.store.task.status).toBe(TaskStatus.PROCESSING);
      expect(harness.store.task.nextPollAt).toBeNull();
      expect(harness.store.task.lastPollError).toBe(
        "PROVIDER_AUTHENTICATION_FAILED"
      );
    }
  );

  it("does not guess an unknown Provider status", async () => {
    const harness = createHarness({
      snapshots: [
        new ProviderProtocolError("NORMALIZE", "Unknown fixture status.")
      ]
    });
    await harness.submit("task-1");
    await runCurrentPoll(harness);

    expect(harness.store.task.status).toBe(TaskStatus.PROCESSING);
    expect(harness.store.task.downloadPending).toBe(false);
    expect(harness.store.task.nextPollAt).toBeNull();
    expect(harness.store.task.lastPollError).toBe("PROVIDER_PROTOCOL_ERROR");
  });

  it("stops when succeeded has no available video output", async () => {
    const harness = createHarness({
      snapshots: [
        {
          providerTaskId: "provider-task-1",
          status: "SUCCEEDED",
          outputs: [],
          usage: []
        }
      ]
    });
    await harness.submit("task-1");
    await runCurrentPoll(harness);

    expect(harness.store.task.status).toBe(TaskStatus.PROCESSING);
    expect(harness.store.task.downloadPending).toBe(false);
    expect(harness.store.task.lastPollError).toBe("PROVIDER_PROTOCOL_ERROR");
  });

  it("lets only one duplicate poll job query the Provider", async () => {
    const harness = createHarness({
      snapshots: [processingSnapshot("running")]
    });
    await harness.submit("task-1");
    const version = harness.store.task.pollVersion;
    harness.setNow(harness.store.task.nextPollAt as Date);

    await Promise.all([
      harness.poll("task-1", version),
      harness.poll("task-1", version)
    ]);

    expect(harness.provider.getCalls).toBe(1);
    expect(harness.store.task.pollVersion).toBe(2);
  });

  it("ignores stale poll versions", async () => {
    const harness = createHarness();
    await harness.submit("task-1");
    await harness.poll("task-1", 0);

    expect(harness.provider.getCalls).toBe(0);
    expect(harness.store.task.pollVersion).toBe(1);
  });

  it("ignores a delayed job left behind after the database version advances", async () => {
    const harness = createHarness();
    await harness.submit("task-1");
    harness.store.task.pollVersion = 2;
    await harness.poll("task-1", 1);

    expect(harness.provider.getCalls).toBe(0);
  });

  it("does not let an in-flight result overwrite local cancellation", async () => {
    const harness = createHarness({
      snapshots: [succeededSnapshot()],
      beforeSnapshotReturn: () => {
        harness.store.task.status = TaskStatus.CANCELLED;
      }
    });
    await harness.submit("task-1");
    await runCurrentPoll(harness);

    expect(harness.store.task.status).toBe(TaskStatus.CANCELLED);
    expect(harness.store.task.downloadPending).toBe(false);
    expect(harness.scheduler.downloads).toEqual([]);
  });

  it("expires locally at the polling deadline without querying again", async () => {
    const harness = createHarness();
    await harness.submit("task-1");
    harness.setNow(harness.store.task.pollDeadlineAt as Date);
    harness.store.task.nextPollAt = harness.now();
    await runCurrentPoll(harness);

    expect(harness.provider.getCalls).toBe(0);
    expect(harness.store.task.status).toBe(TaskStatus.RECONCILIATION_REQUIRED);
    expect(harness.store.task.lastPollError).toBe(
      "LOCAL_POLL_DEADLINE_EXCEEDED"
    );
  });

  it("recovers a missing Redis poll job from persisted scheduling state", async () => {
    const harness = createHarness();
    await harness.submit("task-1");
    harness.scheduler.polls.length = 0;
    harness.setNow(harness.store.task.nextPollAt as Date);

    await harness.reconcile();

    expect(harness.scheduler.polls).toEqual([
      {
        taskId: "task-1",
        pollVersion: 1,
        runAt: harness.store.task.nextPollAt
      }
    ]);
    expect(harness.provider.createCalls).toBe(1);
  });

  it("recovers after database commit succeeds but queue scheduling fails", async () => {
    const harness = createHarness({
      snapshots: [processingSnapshot("running")]
    });
    await harness.submit("task-1");
    harness.scheduler.failNextPoll = true;
    harness.setNow(harness.store.task.nextPollAt as Date);
    await runCurrentPoll(harness);
    expect(harness.store.task.pollVersion).toBe(2);

    harness.scheduler.polls.length = 0;
    harness.setNow(harness.store.task.nextPollAt as Date);
    await harness.reconcile();

    expect(harness.scheduler.polls[0]).toMatchObject({
      taskId: "task-1",
      pollVersion: 2
    });
  });

  it("coordinator restores pending download jobs without polling", async () => {
    const harness = createHarness({ snapshots: [succeededSnapshot()] });
    await harness.submit("task-1");
    await runCurrentPoll(harness);
    harness.scheduler.downloads.length = 0;

    await harness.reconcile();

    expect(harness.scheduler.downloads).toEqual(["task-1"]);
    expect(harness.provider.getCalls).toBe(1);
  });
});

function createHarness(
  options: {
    snapshots?: Array<ProviderTaskSnapshot | Error>;
    beforeSnapshotReturn?: () => void;
    recoveredId?: string;
    createError?: Error;
    failAcceptanceOnce?: boolean;
    providerName?: "mock" | "seedance";
    assetPublisher?: AssetPublisher;
  } = {}
) {
  let currentTime = baseTime;
  const store = new MemoryTaskStore();
  store.failAcceptanceOnce = options.failAcceptanceOnce ?? false;
  const scheduler = new MemoryScheduler();
  const provider = new ScriptedProvider(
    options.snapshots ?? [],
    options.beforeSnapshotReturn,
    options.recoveredId,
    options.createError,
    options.providerName
  );
  const clock = () => new Date(currentTime);
  const dependencies = {
    store,
    provider,
    scheduler,
    policy,
    now: clock,
    random: () => 0.5,
    ...(options.assetPublisher === undefined
      ? {}
      : { assetPublisher: options.assetPublisher })
  };
  return {
    store,
    scheduler,
    provider,
    now: clock,
    setNow(value: Date) {
      currentTime = new Date(value);
    },
    submit: createSubmitProcessor(dependencies),
    poll: createPollProcessor(dependencies),
    reconcile: createPollCoordinator({
      store,
      scheduler,
      batchSize: 10,
      now: clock
    })
  };
}

function referenceVideoPublisher(
  deleted: PublishedRemoteObject[]
): AssetPublisher {
  const remoteObject: PublishedRemoteObject = {
    publisher: "eos",
    bucket: "private-bucket",
    objectKey: `seedance-inputs/videos/${"f".repeat(64)}`
  };
  return {
    publishForProvider: async (input) => ({
      assetId: input.assetId,
      role: "REFERENCE_VIDEO",
      mimeType: "video/mp4",
      sizeBytes: 128,
      checksum: "e".repeat(64),
      url: "https://objects.example.com/video.mp4?signature=redacted",
      expiresAt: new Date(baseTime.getTime() + 120_000),
      remoteObject
    }),
    authorizeProviderAsset: async () => {
      throw new Error("not used");
    },
    deletePublishedAsset: async (object) => {
      deleted.push(object);
    }
  };
}

async function runCurrentPoll(
  harness: ReturnType<typeof createHarness>
): Promise<void> {
  harness.setNow(harness.store.task.nextPollAt as Date);
  await harness.poll("task-1", harness.store.task.pollVersion);
}

function delayFrom(now: Date, next: Date | null): number {
  return (next as Date).getTime() - now.getTime();
}

function processingSnapshot(providerStatus: string): ProviderTaskSnapshot {
  return {
    providerTaskId: "provider-task-1",
    status: "PROCESSING",
    outputs: [],
    usage: [],
    debug: { providerStatus }
  };
}

function succeededSnapshot(): ProviderTaskSnapshot {
  return {
    providerTaskId: "provider-task-1",
    status: "SUCCEEDED",
    outputs: [{ kind: "video", available: true }],
    usage: []
  };
}

function failedSnapshot(): ProviderTaskSnapshot {
  return {
    providerTaskId: "provider-task-1",
    status: "FAILED",
    outputs: [],
    usage: [],
    error: {
      code: "PROVIDER_TASK_FAILED",
      message: "Provider task failed.",
      retryable: false
    }
  };
}

type MemoryTask = SubmissionTask & {
  pollVersion: number;
  pollAttempt: number;
  pollTransientErrors: number;
  pollStartedAt: Date | null;
  nextPollAt: Date | null;
  lastPolledAt: Date | null;
  pollDeadlineAt: Date | null;
  pollLeaseUntil: Date | null;
  lastProviderStatus: string | null;
  lastPollError: string | null;
  downloadPending: boolean;
  downloadVersion: number;
  nextDownloadAt: Date | null;
  downloadDeadlineAt: Date | null;
  errorCode: string | null;
  cleanupReady: boolean;
};

class MemoryTaskStore implements TaskStore {
  failAcceptanceOnce = false;
  readonly publishedAssets: PublishedRemoteObject[] = [];
  readonly cleanupErrors: string[] = [];
  outcomeAudit?: ProviderCreateAudit;
  readonly task: MemoryTask = {
    id: "task-1",
    provider: "mock",
    clientRequestId: "request-1",
    providerTaskId: null,
    status: TaskStatus.QUEUED,
    model: "mock-video-v1",
    prompt: "Fixture prompt",
    parameters: {
      ratio: "16:9",
      resolution: "720p",
      duration: "5",
      scenario: "slow",
      includeUsage: true
    },
    referenceAssetIds: [],
    recoveredProviderTaskId: null,
    pollVersion: 0,
    pollAttempt: 0,
    pollTransientErrors: 0,
    pollStartedAt: null,
    nextPollAt: null,
    lastPolledAt: null,
    pollDeadlineAt: null,
    pollLeaseUntil: null,
    lastProviderStatus: null,
    lastPollError: null,
    downloadPending: false,
    downloadVersion: 0,
    nextDownloadAt: null,
    downloadDeadlineAt: null,
    errorCode: null,
    cleanupReady: false
  };

  async loadSubmissionTask(taskId: string): Promise<SubmissionTask | null> {
    return taskId === this.task.id ? { ...this.task } : null;
  }

  async claimSubmission(task: SubmissionTask): Promise<boolean> {
    if (
      this.task.id !== task.id ||
      this.task.status !== TaskStatus.QUEUED ||
      this.task.providerTaskId !== null
    ) {
      return false;
    }
    this.task.status = TaskStatus.SUBMITTING;
    return true;
  }

  async recordSubmissionAttempt(): Promise<void> {}

  async recordSubmissionResultAudit(): Promise<void> {}

  async acceptSubmission(
    task: SubmissionTask,
    providerTaskId: string,
    schedule: InitialPollSchedule
  ): Promise<boolean> {
    if (this.failAcceptanceOnce) {
      this.failAcceptanceOnce = false;
      throw new Error("Simulated database outage.");
    }
    if (
      this.task.id !== task.id ||
      this.task.status !== TaskStatus.SUBMITTING ||
      this.task.providerTaskId !== null
    ) {
      return false;
    }
    Object.assign(this.task, {
      status: TaskStatus.PROCESSING,
      providerTaskId,
      recoveredProviderTaskId: providerTaskId,
      pollStartedAt: schedule.now,
      nextPollAt: schedule.nextPollAt,
      pollDeadlineAt: schedule.pollDeadlineAt,
      pollVersion: schedule.pollVersion,
      pollAttempt: 0,
      pollTransientErrors: 0,
      cleanupReady: false
    });
    return true;
  }

  async markSubmissionOutcomeUnknown(
    _task: SubmissionTask,
    audit?: ProviderCreateAudit
  ): Promise<void> {
    this.task.status = TaskStatus.RECONCILIATION_REQUIRED;
    this.task.errorCode = "PROVIDER_CREATE_OUTCOME_UNKNOWN";
    this.task.cleanupReady = false;
    this.outcomeAudit = audit;
  }

  async markSubmissionFailed(
    _task: SubmissionTask,
    _now: Date,
    errorCode: string
  ): Promise<void> {
    this.task.status = TaskStatus.FAILED;
    this.task.errorCode = errorCode;
    this.task.cleanupReady = true;
  }

  async recordPublishedAsset(
    _taskId: string,
    _assetId: string,
    remoteObject: PublishedRemoteObject
  ): Promise<void> {
    this.publishedAssets.push(remoteObject);
  }

  async findPublishedAssets(): Promise<readonly PublishedRemoteObject[]> {
    return this.task.cleanupReady ? [...this.publishedAssets] : [];
  }

  async findTerminalTasksWithPublishedAssets(): Promise<readonly string[]> {
    return this.task.cleanupReady &&
      this.publishedAssets.length > 0 &&
      [
        TaskStatus.SUCCEEDED,
        TaskStatus.FAILED,
        TaskStatus.CANCELLED,
        TaskStatus.EXPIRED
      ].includes(this.task.status)
      ? [this.task.id]
      : [];
  }

  async markPublishedAssetDeleted(
    remoteObject: PublishedRemoteObject
  ): Promise<void> {
    const index = this.publishedAssets.findIndex(
      (value) => value.objectKey === remoteObject.objectKey
    );
    if (index >= 0) this.publishedAssets.splice(index, 1);
  }

  async markPublishedAssetCleanupFailed(
    _remoteObject: PublishedRemoteObject,
    errorCode: string
  ): Promise<void> {
    this.cleanupErrors.push(errorCode);
  }

  async claimPoll(
    taskId: string,
    pollVersion: number,
    now: Date,
    leaseUntil: Date
  ): Promise<PollClaim | null> {
    if (
      taskId !== this.task.id ||
      this.task.status !== TaskStatus.PROCESSING ||
      this.task.providerTaskId === null ||
      this.task.pollVersion !== pollVersion ||
      this.task.nextPollAt === null ||
      this.task.nextPollAt > now ||
      this.task.downloadPending ||
      (this.task.pollLeaseUntil !== null && this.task.pollLeaseUntil > now) ||
      this.task.pollDeadlineAt === null
    ) {
      return null;
    }
    this.task.pollLeaseUntil = leaseUntil;
    return {
      taskId,
      providerTaskId: this.task.providerTaskId,
      pollVersion,
      pollAttempt: this.task.pollAttempt,
      transientErrors: this.task.pollTransientErrors,
      pollDeadlineAt: this.task.pollDeadlineAt,
      leaseUntil
    };
  }

  async scheduleNextPoll(
    claim: PollClaim,
    schedule: NextPollSchedule
  ): Promise<boolean> {
    if (!this.isCurrentClaim(claim)) return false;
    Object.assign(this.task, {
      pollVersion: claim.pollVersion + 1,
      pollAttempt: this.task.pollAttempt + 1,
      pollTransientErrors: schedule.transientErrors,
      nextPollAt: schedule.nextPollAt,
      lastPolledAt: schedule.now,
      pollLeaseUntil: null,
      lastProviderStatus: schedule.providerStatus ?? null,
      lastPollError: schedule.lastPollError ?? null
    });
    return true;
  }

  async markDownloadPending(
    claim: PollClaim,
    now: Date,
    downloadDeadlineAt: Date,
    _providerName: string,
    _usage: readonly ProviderUsage[],
    providerStatus?: string
  ): Promise<DownloadSchedule | null> {
    if (!this.isCurrentClaim(claim)) return null;
    Object.assign(this.task, {
      pollAttempt: this.task.pollAttempt + 1,
      nextPollAt: null,
      lastPolledAt: now,
      pollLeaseUntil: null,
      lastProviderStatus: providerStatus ?? null,
      lastPollError: null,
      downloadPending: true,
      downloadVersion: 1,
      nextDownloadAt: now,
      downloadDeadlineAt
    });
    return {
      taskId: this.task.id,
      providerTaskId: claim.providerTaskId,
      downloadVersion: 1,
      nextDownloadAt: now
    };
  }

  async markProviderFailed(
    claim: PollClaim,
    now: Date,
    errorCode: string,
    _errorMessage: string,
    providerStatus?: string
  ): Promise<boolean> {
    if (!this.isCurrentClaim(claim)) return false;
    Object.assign(this.task, {
      status: TaskStatus.FAILED,
      nextPollAt: null,
      lastPolledAt: now,
      pollLeaseUntil: null,
      lastProviderStatus: providerStatus ?? null,
      errorCode,
      cleanupReady: true
    });
    return true;
  }

  async markProviderStopped(
    claim: PollClaim,
    now: Date,
    status: Extract<TaskStatus, "CANCELLED" | "EXPIRED">,
    providerStatus?: string
  ): Promise<boolean> {
    if (!this.isCurrentClaim(claim)) return false;
    Object.assign(this.task, {
      status,
      nextPollAt: null,
      lastPolledAt: now,
      pollLeaseUntil: null,
      lastProviderStatus: providerStatus ?? null,
      errorCode: null,
      cleanupReady: true
    });
    return true;
  }

  async stopPollingForManualReview(
    claim: PollClaim,
    _now: Date,
    errorCode: string
  ): Promise<boolean> {
    if (!this.isCurrentClaim(claim)) return false;
    Object.assign(this.task, {
      nextPollAt: null,
      pollLeaseUntil: null,
      lastPollError: errorCode,
      errorCode
    });
    return true;
  }

  async expireLocalPoll(claim: PollClaim): Promise<boolean> {
    if (!this.isCurrentClaim(claim)) return false;
    Object.assign(this.task, {
      status: TaskStatus.RECONCILIATION_REQUIRED,
      nextPollAt: null,
      pollLeaseUntil: null,
      lastPollError: "LOCAL_POLL_DEADLINE_EXCEEDED",
      errorCode: "LOCAL_POLL_DEADLINE_EXCEEDED",
      cleanupReady: false
    });
    return true;
  }

  async findRecoverablePolls(
    now: Date,
    limit: number
  ): Promise<readonly RecoverablePoll[]> {
    return this.task.status === TaskStatus.PROCESSING &&
      this.task.providerTaskId !== null &&
      !this.task.downloadPending &&
      this.task.nextPollAt !== null &&
      this.task.nextPollAt <= now &&
      (this.task.pollLeaseUntil === null || this.task.pollLeaseUntil <= now)
      ? [
          {
            taskId: this.task.id,
            pollVersion: this.task.pollVersion,
            nextPollAt: this.task.nextPollAt
          }
        ].slice(0, limit)
      : [];
  }

  async findPendingDownloads(): Promise<readonly DownloadSchedule[]> {
    return this.task.status === TaskStatus.PROCESSING &&
      this.task.downloadPending &&
      this.task.providerTaskId !== null &&
      this.task.nextDownloadAt !== null
      ? [
          {
            taskId: this.task.id,
            providerTaskId: this.task.providerTaskId,
            downloadVersion: this.task.downloadVersion,
            nextDownloadAt: this.task.nextDownloadAt
          }
        ]
      : [];
  }

  async claimDownload(): Promise<DownloadClaim | null> {
    return null;
  }

  async loadVideoOutput(): Promise<null> {
    return null;
  }

  async persistVideoOutputAndComplete(): Promise<boolean> {
    return false;
  }

  async invalidateVideoOutput(): Promise<null> {
    return null;
  }

  async scheduleDownloadRetry(): Promise<boolean> {
    return false;
  }

  async stopDownload(): Promise<boolean> {
    return false;
  }

  private isCurrentClaim(claim: PollClaim): boolean {
    return (
      this.task.status === TaskStatus.PROCESSING &&
      this.task.providerTaskId === claim.providerTaskId &&
      this.task.pollVersion === claim.pollVersion &&
      this.task.pollLeaseUntil?.getTime() === claim.leaseUntil.getTime() &&
      !this.task.downloadPending
    );
  }
}

class MemoryScheduler implements ProviderJobScheduler {
  readonly polls: {
    taskId: string;
    pollVersion: number;
    runAt: Date;
  }[] = [];
  readonly downloads: string[] = [];
  failNextPoll = false;

  async schedulePoll(
    taskId: string,
    pollVersion: number,
    runAt: Date
  ): Promise<void> {
    if (this.failNextPoll) {
      this.failNextPoll = false;
      throw new Error("Simulated Redis outage.");
    }
    this.polls.push({ taskId, pollVersion, runAt });
  }

  async scheduleDownload(
    taskId: string,
    providerTaskId: string,
    downloadVersion: number,
    runAt: Date
  ): Promise<void> {
    void providerTaskId;
    void downloadVersion;
    void runAt;
    this.downloads.push(taskId);
  }
}

class ScriptedProvider implements SeedanceProvider {
  readonly name: "mock" | "seedance";
  createCalls = 0;
  getCalls = 0;
  recoverCalls = 0;
  private readonly snapshots: Array<ProviderTaskSnapshot | Error>;
  private createdTaskId: string | undefined;
  lastCreateInput: CreateTaskInput | undefined;

  constructor(
    snapshots: Array<ProviderTaskSnapshot | Error>,
    private readonly beforeSnapshotReturn?: () => void,
    private readonly recoveredId?: string,
    private readonly createError?: Error,
    name: "mock" | "seedance" = "mock"
  ) {
    this.snapshots = [...snapshots];
    this.name = name;
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return {
      provider: this.name,
      label: "Fixture",
      testOnly: true,
      supportsCancellation: false,
      supportsReferenceImage: true,
      maxReferenceImages: this.name === "seedance" ? 1 : 8,
      acceptedAssetTypes: [],
      models: []
    };
  }

  validateParameters(): ValidationResult {
    return { ok: true, value: {} };
  }

  async createTask(input: CreateTaskInput): Promise<ProviderTaskSnapshot> {
    this.createCalls += 1;
    this.lastCreateInput = input;
    if (this.createError !== undefined) throw this.createError;
    this.createdTaskId = "provider-task-1";
    return processingSnapshot("queued");
  }

  async recoverTask(): Promise<string | null> {
    this.recoverCalls += 1;
    return this.recoveredId ?? this.createdTaskId ?? null;
  }

  async getTask(): Promise<ProviderTaskSnapshot> {
    this.getCalls += 1;
    const value = this.snapshots.shift() ?? processingSnapshot("running");
    this.beforeSnapshotReturn?.();
    if (value instanceof Error) throw value;
    return value;
  }

  async cancelTask(): Promise<ProviderTaskSnapshot> {
    throw new Error("Cancellation is not used.");
  }

  normalizeStatus(): ProviderTaskSnapshot["status"] {
    return "PROCESSING";
  }

  normalizeUsage() {
    return [];
  }

  async downloadOutput(): Promise<ProviderDownload> {
    return { body: Readable.from(Buffer.from("fixture")) };
  }
}
