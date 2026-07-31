import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { AssetKind, AssetRole, PrismaClient, TaskStatus } from "@prisma/client";
import { loadLocalEnvironment } from "@seedance/config";
import { openMockVideoFixture } from "@seedance/seedance-provider";
import { providerJobId } from "@seedance/shared";
import { LocalStorage } from "@seedance/storage";
import { Queue, Worker } from "bullmq";
import Redis from "ioredis";

import { createDownloadProcessor } from "../dist/download-processor.js";
import { BullMqProviderJobScheduler } from "../dist/job-scheduler.js";
import { createPollCoordinator } from "../dist/poll-coordinator.js";
import { PrismaTaskStore } from "../dist/task-store.js";

loadLocalEnvironment(resolve(process.cwd(), ".env"));

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
assert(databaseUrl, "DATABASE_URL is required.");
assert(redisUrl, "REDIS_URL is required.");

const policy = {
  maxBytes: 8 * 1024 * 1024,
  timeoutMs: 2_000,
  baseRetryIntervalMs: 50,
  maxRetryIntervalMs: 200,
  maxAttempts: 3,
  jitterRatio: 0
};
const redisConnections = new Set();

try {
  if (process.argv[2] === "recover-child") {
    await runRecoveryChild(process.argv[3], process.argv[4], process.argv[5]);
  } else if (process.argv[2] === "verify-retained") {
    await verifyRetained(process.argv[3]);
  } else {
    await runAcceptance();
  }
} finally {
  disconnectRedisConnections();
}

async function runAcceptance() {
  const runId = `${Date.now()}-${process.pid}`;
  const prefix = `download-infra-${runId}`;
  const prisma = new PrismaClient();
  const queueName = `${prefix}-queue`;
  const redis = createRedis();
  const queue = new Queue(queueName, { connection: redis });
  const scheduler = new BullMqProviderJobScheduler(queue);
  const results = {};
  let retained;

  try {
    results.success = await verifySuccessfulDownload(
      prisma,
      queueName,
      scheduler,
      prefix
    );
    retained = results.success.retained;
    results.concurrency = await verifyConcurrency(
      prisma,
      queueName,
      scheduler,
      prefix
    );
    results.redisRecovery = await verifyRedisRecovery(
      prisma,
      queue,
      queueName,
      scheduler,
      prefix
    );
    results.processRestart = await verifyProcessRestart(
      prisma,
      queue,
      queueName,
      prefix
    );
    results.fileCommitRecovery = await verifyFileCommitRecovery(
      prisma,
      queueName,
      scheduler,
      prefix
    );
    results.databaseRecovery = await verifyDatabaseRecovery(
      prisma,
      queueName,
      scheduler,
      prefix
    );
    results.cancellation = await verifyCancellationRace(
      prisma,
      queueName,
      scheduler,
      prefix
    );

    const stateFile = join(
      tmpdir(),
      `seedance-download-retained-${runId}.json`
    );
    await writeFile(stateFile, JSON.stringify(retained), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    process.stdout.write(
      `${JSON.stringify({ runId, queueName, stateFile, results }, null, 2)}\n`
    );
  } finally {
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
    redis.disconnect();
    await prisma.videoTask
      .deleteMany({
        where: {
          clientRequestId: {
            startsWith: prefix,
            not: retained?.clientRequestId
          }
        }
      })
      .catch(() => undefined);
    await deleteOrphanedAcceptanceAssets(prisma, prefix);
    await prisma.$disconnect();
  }
}

async function verifySuccessfulDownload(prisma, queueName, scheduler, prefix) {
  const root = await createStorageRoot();
  const task = await createDownloadTask(prisma, `${prefix}-success`);
  const provider = fixtureDownloadProvider();
  let consumed = 0;
  const worker = createWorker(
    queueName,
    createProcessor(prisma, scheduler, root, provider),
    () => {
      consumed += 1;
    }
  );
  try {
    await scheduler.scheduleDownload(
      task.id,
      task.providerTaskId,
      1,
      new Date()
    );
    const completed = await waitForCompleted(prisma, task.id);
    const output = await prisma.videoOutput.findUniqueOrThrow({
      where: { taskId: task.id }
    });
    assert.equal(completed.downloadPending, false);
    assert.equal(provider.downloadCalls, 1);
    assert.equal(consumed, 1);
    assert.match(output.sha256, /^[a-f0-9]{64}$/);
    assert(output.fileSize > 0n);
    await new LocalStorage(root).inspect(output.storageKey, {
      maxBytes: policy.maxBytes,
      timeoutMs: policy.timeoutMs,
      validate: async () => undefined
    });
    return {
      taskId: task.id,
      consumed,
      downloadCalls: provider.downloadCalls,
      status: completed.status,
      sha256: output.sha256,
      retained: {
        taskId: task.id,
        clientRequestId: task.clientRequestId,
        assetId: output.assetId,
        storageRoot: root,
        storageKey: output.storageKey,
        sha256: output.sha256
      }
    };
  } finally {
    await worker.close();
  }
}

async function verifyConcurrency(prisma, queueName, scheduler, prefix) {
  const root = await createStorageRoot();
  const task = await createDownloadTask(prisma, `${prefix}-concurrency`);
  let release;
  const gate = new Promise((resolvePromise) => {
    release = resolvePromise;
  });
  const provider = fixtureDownloadProvider(gate);
  const worker = createWorker(
    queueName,
    createProcessor(prisma, scheduler, root, provider),
    undefined,
    2
  );
  try {
    await Promise.all([
      scheduler.scheduleDownload(task.id, task.providerTaskId, 1, new Date()),
      queueFor(queueName).then(async (queue) => {
        try {
          await queue.add("provider-download", downloadPayload(task, 1), {
            jobId: `${prefix}-duplicate`,
            removeOnComplete: true
          });
        } finally {
          await queue.close();
        }
      })
    ]);
    await waitFor(() => (provider.downloadCalls === 1 ? true : null));
    release();
    await waitForCompleted(prisma, task.id);
    await addDownloadJob(queueName, task, 0, `${prefix}-stale`);
    await waitForQueueIdle(queueName);
    assert.equal(provider.downloadCalls, 1);
    assert.equal(
      await prisma.videoOutput.count({ where: { taskId: task.id } }),
      1
    );
    return {
      providerDownloads: provider.downloadCalls,
      oneOutput: true,
      staleVersionIgnored: true
    };
  } finally {
    release();
    await worker.close();
    await cleanupTask(prisma, task.id);
    await rm(root, { recursive: true, force: true });
  }
}

async function verifyRedisRecovery(
  prisma,
  queue,
  queueName,
  scheduler,
  prefix
) {
  const root = await createStorageRoot();
  const task = await createDownloadTask(prisma, `${prefix}-redis-loss`);
  const provider = fixtureDownloadProvider();
  const jobId = providerJobId(downloadPayload(task, 1));
  try {
    await scheduler.scheduleDownload(
      task.id,
      task.providerTaskId,
      1,
      new Date(Date.now() + 30_000)
    );
    const lost = await queue.getJob(jobId);
    assert(lost, "Expected delayed download job.");
    await lost.remove();
    assert.equal(await queue.getJob(jobId), undefined);

    await createPollCoordinator({
      store: new PrismaTaskStore(prisma),
      scheduler,
      batchSize: 10
    })();
    assert(await queue.getJob(jobId), "Coordinator did not restore download.");
    const worker = createWorker(
      queueName,
      createProcessor(prisma, scheduler, root, provider)
    );
    try {
      await waitForCompleted(prisma, task.id);
    } finally {
      await worker.close();
    }
    assert.equal(provider.downloadCalls, 1);
    return { restoredJobId: jobId, providerDownloads: 1 };
  } finally {
    await cleanupTask(prisma, task.id);
    await rm(root, { recursive: true, force: true });
  }
}

async function verifyProcessRestart(prisma, queue, queueName, prefix) {
  const root = await createStorageRoot();
  const task = await createDownloadTask(prisma, `${prefix}-restart`);
  const jobId = providerJobId(downloadPayload(task, 1));
  assert.equal(await queue.getJob(jobId), undefined);
  try {
    await spawnRecoveryChild(queueName, root, task.id);
    const completed = await prisma.videoTask.findUniqueOrThrow({
      where: { id: task.id }
    });
    assert.equal(completed.status, TaskStatus.SUCCEEDED);
    assert.equal(
      await prisma.videoOutput.count({ where: { taskId: task.id } }),
      1
    );
    return {
      restoredByFreshProcess: true,
      status: completed.status,
      createCalls: 0
    };
  } finally {
    await cleanupTask(prisma, task.id);
    await rm(root, { recursive: true, force: true });
  }
}

async function verifyFileCommitRecovery(prisma, queueName, scheduler, prefix) {
  const root = await createStorageRoot();
  const task = await createDownloadTask(prisma, `${prefix}-file-db-failure`);
  const provider = fixtureDownloadProvider();
  const baseStore = new PrismaTaskStore(prisma);
  let failOnce = true;
  const store = downloadStore(baseStore, {
    async persistVideoOutputAndComplete(claim, output, now) {
      if (failOnce) {
        failOnce = false;
        throw new Error("INJECTED_DATABASE_FAILURE");
      }
      return baseStore.persistVideoOutputAndComplete(claim, output, now);
    }
  });
  const worker = createWorker(
    queueName,
    createDownloadProcessor({
      store,
      provider,
      storage: new LocalStorage(root),
      scheduler,
      policy,
      random: () => 0.5
    })
  );
  try {
    await scheduler.scheduleDownload(
      task.id,
      task.providerTaskId,
      1,
      new Date()
    );
    const completed = await waitForCompleted(prisma, task.id);
    assert.equal(completed.downloadVersion, 2);
    assert.equal(provider.downloadCalls, 1);
    return {
      providerDownloads: 1,
      recoveredVersion: completed.downloadVersion
    };
  } finally {
    await worker.close();
    await cleanupTask(prisma, task.id);
    await rm(root, { recursive: true, force: true });
  }
}

async function verifyDatabaseRecovery(prisma, queueName, scheduler, prefix) {
  const root = await createStorageRoot();
  const storage = new LocalStorage(root);
  const task = await createDownloadTask(prisma, `${prefix}-database-output`);
  const storageKey = `outputs/${task.id}/video.mp4`;
  const stored = await storage.putAtomic(storageKey, openMockVideoFixture(), {
    maxBytes: policy.maxBytes,
    timeoutMs: policy.timeoutMs,
    validate: async () => undefined
  });
  const asset = await prisma.asset.create({
    data: {
      kind: AssetKind.OUTPUT_VIDEO,
      storageKey,
      originalName: `${prefix}-database-output.mp4`,
      mimeType: "video/mp4",
      sizeBytes: stored.sizeBytes,
      checksum: stored.sha256
    }
  });
  await prisma.$transaction([
    prisma.taskAsset.create({
      data: {
        taskId: task.id,
        assetId: asset.id,
        role: AssetRole.GENERATED_VIDEO
      }
    }),
    prisma.videoOutput.create({
      data: {
        taskId: task.id,
        assetId: asset.id,
        providerTaskId: task.providerTaskId,
        storageKey,
        sha256: stored.sha256,
        fileSize: stored.sizeBytes,
        mimeType: "video/mp4"
      }
    })
  ]);
  const provider = fixtureDownloadProvider();
  const worker = createWorker(
    queueName,
    createProcessor(prisma, scheduler, root, provider)
  );
  try {
    await scheduler.scheduleDownload(
      task.id,
      task.providerTaskId,
      1,
      new Date()
    );
    await waitForCompleted(prisma, task.id);
    assert.equal(provider.downloadCalls, 0);
    return { providerDownloads: 0, completedFromExistingMetadata: true };
  } finally {
    await worker.close();
    await cleanupTask(prisma, task.id);
    await rm(root, { recursive: true, force: true });
  }
}

async function verifyCancellationRace(prisma, queueName, scheduler, prefix) {
  const root = await createStorageRoot();
  const task = await createDownloadTask(prisma, `${prefix}-cancel-race`);
  let release;
  const gate = new Promise((resolvePromise) => {
    release = resolvePromise;
  });
  const provider = fixtureDownloadProvider(gate);
  const worker = createWorker(
    queueName,
    createProcessor(prisma, scheduler, root, provider)
  );
  try {
    await scheduler.scheduleDownload(
      task.id,
      task.providerTaskId,
      1,
      new Date()
    );
    await waitFor(() => (provider.downloadCalls === 1 ? true : null));
    await prisma.videoTask.update({
      where: { id: task.id },
      data: { status: TaskStatus.CANCELLED, completedAt: new Date() }
    });
    release();
    await waitForQueueIdle(queueName);
    const cancelled = await prisma.videoTask.findUniqueOrThrow({
      where: { id: task.id }
    });
    assert.equal(cancelled.status, TaskStatus.CANCELLED);
    assert.equal(
      await prisma.videoOutput.count({ where: { taskId: task.id } }),
      0
    );
    return { status: cancelled.status, outputRows: 0 };
  } finally {
    release();
    await worker.close();
    await cleanupTask(prisma, task.id);
    await rm(root, { recursive: true, force: true });
  }
}

async function runRecoveryChild(queueName, root, taskId) {
  assert(queueName && root && taskId, "Recovery child arguments are required.");
  const prisma = new PrismaClient();
  const queue = new Queue(queueName, { connection: createRedis() });
  const scheduler = new BullMqProviderJobScheduler(queue);
  const provider = fixtureDownloadProvider();
  const worker = createWorker(
    queueName,
    createProcessor(prisma, scheduler, root, provider)
  );
  try {
    await createPollCoordinator({
      store: new PrismaTaskStore(prisma),
      scheduler,
      batchSize: 10
    })();
    await waitForCompleted(prisma, taskId);
    assert.equal(provider.downloadCalls, 1);
  } finally {
    await worker.close();
    await queue.close();
    await prisma.$disconnect();
  }
}

async function verifyRetained(stateFile) {
  assert(stateFile, "Retained state file is required.");
  const retained = JSON.parse(await readFile(stateFile, "utf8"));
  assert.match(retained.taskId, /^[A-Za-z0-9_-]+$/);
  assert.match(retained.sha256, /^[a-f0-9]{64}$/);
  const prisma = new PrismaClient();
  try {
    const task = await prisma.videoTask.findUniqueOrThrow({
      where: { id: retained.taskId }
    });
    const output = await prisma.videoOutput.findUniqueOrThrow({
      where: { taskId: retained.taskId }
    });
    const inspected = await new LocalStorage(retained.storageRoot).inspect(
      retained.storageKey,
      {
        maxBytes: policy.maxBytes,
        timeoutMs: policy.timeoutMs,
        validate: async () => undefined
      }
    );
    assert.equal(task.status, TaskStatus.SUCCEEDED);
    assert.equal(output.sha256, retained.sha256);
    assert.equal(inspected.sha256, retained.sha256);
    process.stdout.write(
      `${JSON.stringify({
        taskId: retained.taskId,
        status: task.status,
        sha256Before: retained.sha256,
        sha256After: inspected.sha256,
        persisted: true
      })}\n`
    );
    await cleanupTask(prisma, retained.taskId);
    await rm(retained.storageRoot, { recursive: true, force: true });
    await rm(stateFile);
  } finally {
    await prisma.$disconnect();
  }
}

function createProcessor(prisma, scheduler, root, provider) {
  return createDownloadProcessor({
    store: new PrismaTaskStore(prisma),
    provider,
    storage: new LocalStorage(root),
    scheduler,
    policy,
    random: () => 0.5
  });
}

function createWorker(queueName, processor, onConsumed, concurrency = 1) {
  return new Worker(
    queueName,
    async (job) => {
      if (job.data.kind !== "provider-download") return;
      onConsumed?.();
      await processor(
        job.data.taskId,
        job.data.providerTaskId,
        job.data.downloadVersion
      );
    },
    { connection: createRedis(), concurrency }
  );
}

function fixtureDownloadProvider(gate) {
  return {
    downloadCalls: 0,
    async downloadOutput() {
      this.downloadCalls += 1;
      if (gate) await gate;
      return {
        body: openMockVideoFixture(),
        contentType: "video/mp4"
      };
    }
  };
}

async function createDownloadTask(prisma, clientRequestId) {
  return prisma.videoTask.create({
    data: {
      clientRequestId,
      provider: "mock",
      providerTaskId: `fixture-${clientRequestId}`,
      model: "mock-video-v1",
      status: TaskStatus.PROCESSING,
      prompt: "Download infrastructure acceptance fixture",
      parameters: {
        ratio: "16:9",
        resolution: "720p",
        duration: "5",
        scenario: "success",
        includeUsage: false
      },
      submittedAt: new Date(),
      downloadPending: true,
      downloadStartedAt: new Date(),
      nextDownloadAt: new Date(Date.now() - 100),
      downloadDeadlineAt: new Date(Date.now() + 60_000),
      downloadVersion: 1
    }
  });
}

function downloadPayload(task, version) {
  return {
    kind: "provider-download",
    taskId: task.id,
    providerTaskId: task.providerTaskId,
    downloadVersion: version
  };
}

async function addDownloadJob(queueName, task, version, jobId) {
  const queue = await queueFor(queueName);
  try {
    await queue.add("provider-download", downloadPayload(task, version), {
      jobId,
      removeOnComplete: true,
      removeOnFail: true
    });
  } finally {
    await queue.close();
  }
}

async function queueFor(queueName) {
  return new Queue(queueName, { connection: createRedis() });
}

function downloadStore(baseStore, overrides) {
  return {
    claimDownload: baseStore.claimDownload.bind(baseStore),
    loadVideoOutput: baseStore.loadVideoOutput.bind(baseStore),
    persistVideoOutputAndComplete:
      overrides.persistVideoOutputAndComplete ??
      baseStore.persistVideoOutputAndComplete.bind(baseStore),
    invalidateVideoOutput: baseStore.invalidateVideoOutput.bind(baseStore),
    scheduleDownloadRetry: baseStore.scheduleDownloadRetry.bind(baseStore),
    stopDownload: baseStore.stopDownload.bind(baseStore)
  };
}

async function waitForCompleted(prisma, taskId) {
  return waitFor(async () => {
    const task = await prisma.videoTask.findUniqueOrThrow({
      where: { id: taskId }
    });
    return task.status === TaskStatus.SUCCEEDED ? task : null;
  });
}

async function waitForQueueIdle(queueName) {
  const queue = await queueFor(queueName);
  try {
    await waitFor(async () => {
      const counts = await queue.getJobCounts(
        "active",
        "waiting",
        "prioritized",
        "delayed"
      );
      return counts.active === 0 &&
        counts.waiting === 0 &&
        counts.prioritized === 0 &&
        counts.delayed === 0
        ? true
        : null;
    });
  } finally {
    await queue.close();
  }
}

async function waitFor(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(25);
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms.`);
}

async function spawnRecoveryChild(queueName, root, taskId) {
  const { spawn } = await import("node:child_process");
  const script = fileURLToPath(import.meta.url);
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      [script, "recover-child", queueName, root, taskId],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", "ignore", "pipe"]
      }
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`Recovery child failed: ${stderr}`));
    });
  });
}

async function createStorageRoot() {
  return mkdtemp(join(tmpdir(), "seedance-download-infra-"));
}

async function cleanupTask(prisma, taskId) {
  const output = await prisma.videoOutput.findUnique({
    where: { taskId },
    select: { assetId: true }
  });
  await prisma.videoTask.deleteMany({ where: { id: taskId } });
  if (output) {
    await prisma.asset.deleteMany({ where: { id: output.assetId } });
  }
}

async function deleteOrphanedAcceptanceAssets(prisma, prefix) {
  await prisma.asset.deleteMany({
    where: {
      kind: AssetKind.OUTPUT_VIDEO,
      originalName: { startsWith: prefix },
      tasks: { none: {} },
      videoOutput: null
    }
  });
}

function createRedis() {
  const connection = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true
  });
  redisConnections.add(connection);
  return connection;
}

function disconnectRedisConnections() {
  for (const connection of redisConnections) {
    if (connection.status !== "end") connection.disconnect();
  }
}
