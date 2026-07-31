import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

import {
  PrismaClient,
  ProviderSubmissionStatus,
  TaskStatus
} from "@prisma/client";
import { loadLocalEnvironment } from "@seedance/config";
import { MockSeedanceProvider } from "@seedance/seedance-provider";
import { providerJobId } from "@seedance/shared";
import { Queue, Worker } from "bullmq";
import Redis from "ioredis";

import { BullMqProviderJobScheduler } from "../dist/job-scheduler.js";
import { createPollCoordinator } from "../dist/poll-coordinator.js";
import {
  createPollProcessor,
  createSubmitProcessor
} from "../dist/task-processor.js";
import { PrismaTaskStore } from "../dist/task-store.js";

loadLocalEnvironment(resolve(process.cwd(), ".env"));

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
assert(databaseUrl, "DATABASE_URL is required.");
assert(redisUrl, "REDIS_URL is required.");

const policy = {
  baseIntervalMs: 500,
  maxIntervalMs: 2_000,
  maxDurationMs: 60_000,
  requestTimeoutMs: 2_000,
  jitterRatio: 0,
  downloadMaxDurationMs: 60_000
};
const redisConnections = new Set();

try {
  if (process.argv[2] === "recover") {
    await runRecoveryChild(process.argv[3], Number(process.argv[4]));
  } else {
    await runAcceptance();
  }
} finally {
  disconnectRedisConnections();
}

async function runRecoveryChild(queueName, expectedVersion) {
  assert(queueName, "Recovery queue name is required.");
  assert(Number.isSafeInteger(expectedVersion), "Poll version is required.");
  const prisma = new PrismaClient();
  const redis = createRedis();
  const queue = new Queue(queueName, { connection: redis });
  try {
    const coordinator = createPollCoordinator({
      store: new PrismaTaskStore(prisma),
      scheduler: new BullMqProviderJobScheduler(queue),
      batchSize: 20
    });
    await coordinator();
    const jobs = await queue.getJobs(["waiting", "delayed", "paused"]);
    assert(
      jobs.some(
        (job) =>
          job.data.kind === "provider-poll" &&
          job.data.pollVersion === expectedVersion
      ),
      "Startup coordinator did not restore the expected poll job."
    );
  } finally {
    await queue.close();
    redis.disconnect();
    await prisma.$disconnect();
  }
}

async function runAcceptance() {
  const runId = `${Date.now()}-${process.pid}`;
  const prefix = `infra-${runId}`;
  const prisma = new PrismaClient();
  const redis = createRedis();
  const queueNames = [];
  const retained = { taskId: "", clientRequestId: "" };
  let completed = false;

  try {
    const submitPoll = await verifySubmitAndPoll(
      prisma,
      redis,
      prefix,
      queueNames
    );
    retained.taskId = submitPoll.taskId;
    retained.clientRequestId = submitPoll.clientRequestId;

    const concurrency = await verifyConcurrencyAndCancellation(
      prisma,
      redis,
      prefix,
      queueNames
    );
    const redisRecovery = await verifyRedisLossRecovery(
      prisma,
      redis,
      prefix,
      queueNames
    );
    const restartRecovery = await verifyProcessRestartRecovery(
      prisma,
      redis,
      prefix,
      queueNames
    );

    await prisma.videoTask.update({
      where: { id: retained.taskId },
      data: {
        status: TaskStatus.CANCELLED,
        downloadPending: false,
        nextPollAt: null,
        pollLeaseUntil: null,
        completedAt: new Date()
      }
    });
    await prisma.videoTask.deleteMany({
      where: {
        clientRequestId: {
          startsWith: prefix,
          not: retained.clientRequestId
        }
      }
    });

    const submission = await prisma.providerSubmission.findUnique({
      where: { taskId: retained.taskId }
    });
    assert.equal(submission?.status, ProviderSubmissionStatus.ACCEPTED);

    process.stdout.write(
      `${JSON.stringify(
        {
          runId,
          retained,
          submitPoll,
          concurrency,
          redisRecovery,
          restartRecovery
        },
        null,
        2
      )}\n`
    );
    completed = true;
  } finally {
    for (const queueName of queueNames) {
      const queue = new Queue(queueName, { connection: redis });
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
    }
    if (!completed) {
      await prisma.videoTask
        .deleteMany({
          where: { clientRequestId: { startsWith: prefix } }
        })
        .catch(() => undefined);
    }
    redis.disconnect();
    await prisma.$disconnect();
  }
}

async function verifySubmitAndPoll(prisma, redis, prefix, queueNames) {
  const queueName = `${prefix}-submit-poll`;
  queueNames.push(queueName);
  const queue = new Queue(queueName, { connection: redis });
  const scheduler = new BullMqProviderJobScheduler(queue);
  const store = new PrismaTaskStore(prisma);
  const provider = new MockSeedanceProvider();
  let createCalls = 0;
  let getCalls = 0;
  let pollJobs = 0;
  let downloadJobs = 0;

  const originalCreate = provider.createTask.bind(provider);
  provider.createTask = async (input) => {
    createCalls += 1;
    return originalCreate(input);
  };
  const originalGet = provider.getTask.bind(provider);
  provider.getTask = async (taskId) => {
    getCalls += 1;
    return originalGet(taskId);
  };

  const submit = createSubmitProcessor({
    store,
    provider,
    scheduler,
    policy,
    random: () => 0.5
  });
  const poll = createPollProcessor({
    store,
    provider,
    scheduler,
    policy,
    random: () => 0.5
  });
  const clientRequestId = `${prefix}-submit`;
  const task = await prisma.videoTask.create({
    data: {
      clientRequestId,
      provider: "mock",
      model: "mock-video-v1",
      status: TaskStatus.QUEUED,
      prompt: "Infrastructure acceptance fixture",
      parameters: {
        ratio: "16:9",
        resolution: "720p",
        duration: "5",
        scenario: "success",
        includeUsage: false
      }
    }
  });
  const worker = new Worker(
    queueName,
    async (job) => {
      if (job.data.kind === "provider-submit") {
        await submit(job.data.taskId);
      } else if (job.data.kind === "provider-poll") {
        pollJobs += 1;
        await poll(job.data.taskId, job.data.pollVersion);
      } else if (job.data.kind === "provider-download") {
        downloadJobs += 1;
      }
    },
    { connection: createRedis(), concurrency: 2 }
  );

  try {
    const submitJob = { kind: "provider-submit", taskId: task.id };
    await queue.add(submitJob.kind, submitJob, {
      jobId: providerJobId(submitJob),
      removeOnComplete: true,
      removeOnFail: true
    });

    await waitFor(async () => {
      const current = await prisma.videoTask.findUniqueOrThrow({
        where: { id: task.id }
      });
      return current.status === TaskStatus.PROCESSING &&
        current.pollVersion === 1
        ? current
        : null;
    });
    const firstPoll = await queue.getJob(
      providerJobId({
        kind: "provider-poll",
        taskId: task.id,
        pollVersion: 1
      })
    );
    assert(firstPoll, "Submit did not create the first delayed poll job.");
    assert.equal(await firstPoll.getState(), "delayed");

    const ready = await waitFor(async () => {
      const current = await prisma.videoTask.findUniqueOrThrow({
        where: { id: task.id }
      });
      return current.downloadPending ? current : null;
    });
    await waitFor(() => (downloadJobs === 1 ? true : null));

    assert.equal(createCalls, 1);
    assert.equal(getCalls, 2);
    assert.equal(pollJobs, 2);
    assert.equal(ready.status, TaskStatus.PROCESSING);
    assert.equal(ready.downloadPending, true);
    assert.equal(ready.nextPollAt, null);
    assert(ready.providerTaskId);

    return {
      taskId: task.id,
      clientRequestId,
      providerTaskId: ready.providerTaskId,
      createCalls,
      getCalls,
      pollJobs,
      downloadJobs,
      finalStatus: ready.status,
      downloadPending: ready.downloadPending
    };
  } finally {
    await worker.close();
    await queue.close();
  }
}

async function verifyConcurrencyAndCancellation(
  prisma,
  redis,
  prefix,
  queueNames
) {
  const queueName = `${prefix}-concurrency`;
  queueNames.push(queueName);
  const queue = new Queue(queueName, { connection: redis });
  const scheduler = new BullMqProviderJobScheduler(queue);
  const store = new PrismaTaskStore(prisma);
  let getCalls = 0;
  let createCalls = 0;
  let cancelStarted;
  let releaseCancel;
  const cancelStartedPromise = new Promise((resolvePromise) => {
    cancelStarted = resolvePromise;
  });
  const releaseCancelPromise = new Promise((resolvePromise) => {
    releaseCancel = resolvePromise;
  });
  const provider = fixtureProvider({
    create: () => {
      createCalls += 1;
    },
    get: async (providerTaskId) => {
      getCalls += 1;
      if (providerTaskId.endsWith("-cancel")) {
        cancelStarted();
        await releaseCancelPromise;
        return succeededSnapshot(providerTaskId);
      }
      await delay(150);
      return processingSnapshot(providerTaskId);
    }
  });
  const poll = createPollProcessor({
    store,
    provider,
    scheduler,
    policy,
    random: () => 0.5
  });
  const due = new Date(Date.now() - 1_000);
  const deadline = new Date(Date.now() + 60_000);
  const concurrentTask = await createScheduledTask(prisma, {
    clientRequestId: `${prefix}-concurrent`,
    providerTaskId: `${prefix}-provider-concurrent`,
    version: 1,
    due,
    deadline
  });
  const cancelTask = await createScheduledTask(prisma, {
    clientRequestId: `${prefix}-cancel`,
    providerTaskId: `${prefix}-provider-cancel`,
    version: 1,
    due,
    deadline
  });
  const workerOne = createPollWorker(queueName, poll);
  const workerTwo = createPollWorker(queueName, poll);

  try {
    await Promise.all([
      queue.add(
        "provider-poll",
        {
          kind: "provider-poll",
          taskId: concurrentTask.id,
          pollVersion: 1
        },
        { jobId: `${prefix}-duplicate-a`, removeOnComplete: true }
      ),
      queue.add(
        "provider-poll",
        {
          kind: "provider-poll",
          taskId: concurrentTask.id,
          pollVersion: 1
        },
        { jobId: `${prefix}-duplicate-b`, removeOnComplete: true }
      )
    ]);
    await waitFor(async () => {
      const current = await prisma.videoTask.findUniqueOrThrow({
        where: { id: concurrentTask.id }
      });
      return current.pollVersion === 2 ? current : null;
    });
    assert.equal(getCalls, 1);

    await queue.add(
      "provider-poll",
      {
        kind: "provider-poll",
        taskId: concurrentTask.id,
        pollVersion: 1
      },
      { jobId: `${prefix}-stale`, removeOnComplete: true }
    );
    await waitForQueueIdle(queue);
    assert.equal(getCalls, 1);

    await queue.add(
      "provider-poll",
      { kind: "provider-poll", taskId: cancelTask.id, pollVersion: 1 },
      { jobId: `${prefix}-cancel-race`, removeOnComplete: true }
    );
    await cancelStartedPromise;
    await prisma.videoTask.update({
      where: { id: cancelTask.id },
      data: {
        status: TaskStatus.CANCELLED,
        completedAt: new Date()
      }
    });
    releaseCancel();
    await waitForQueueIdle(queue);
    const cancelled = await prisma.videoTask.findUniqueOrThrow({
      where: { id: cancelTask.id }
    });
    assert.equal(cancelled.status, TaskStatus.CANCELLED);
    assert.equal(cancelled.downloadPending, false);

    const terminalTask = await createScheduledTask(prisma, {
      clientRequestId: `${prefix}-terminal`,
      providerTaskId: `${prefix}-provider-terminal`,
      version: 1,
      due,
      deadline,
      status: TaskStatus.FAILED
    });
    const downloadTask = await createScheduledTask(prisma, {
      clientRequestId: `${prefix}-download-pending`,
      providerTaskId: `${prefix}-provider-download`,
      version: 1,
      due,
      deadline,
      downloadPending: true
    });
    const recoverable = await store.findRecoverablePolls(new Date(), 100);
    assert(!recoverable.some((item) => item.taskId === terminalTask.id));
    assert(!recoverable.some((item) => item.taskId === downloadTask.id));

    return {
      duplicateProviderQueries: 0,
      providerQueriesAfterDuplicatePair: 1,
      staleVersionIgnored: true,
      cancellationPreserved: cancelled.status,
      terminalExcluded: true,
      downloadPendingExcluded: true,
      createCalls
    };
  } finally {
    await workerOne.close();
    await workerTwo.close();
    await queue.close();
  }
}

async function verifyRedisLossRecovery(prisma, redis, prefix, queueNames) {
  const queueName = `${prefix}-redis-loss`;
  queueNames.push(queueName);
  const queue = new Queue(queueName, { connection: redis });
  const scheduler = new BullMqProviderJobScheduler(queue);
  const store = new PrismaTaskStore(prisma);
  let getCalls = 0;
  let createCalls = 0;
  const provider = fixtureProvider({
    create: () => {
      createCalls += 1;
    },
    get: async (providerTaskId) => {
      getCalls += 1;
      return processingSnapshot(providerTaskId);
    }
  });
  const poll = createPollProcessor({
    store,
    provider,
    scheduler,
    policy,
    random: () => 0.5
  });
  const task = await createScheduledTask(prisma, {
    clientRequestId: `${prefix}-redis-loss`,
    providerTaskId: `${prefix}-provider-redis-loss`,
    version: 3,
    due: new Date(Date.now() - 500),
    deadline: new Date(Date.now() + 60_000)
  });
  const jobId = providerJobId({
    kind: "provider-poll",
    taskId: task.id,
    pollVersion: 3
  });

  try {
    await scheduler.schedulePoll(task.id, 3, new Date(Date.now() + 30_000));
    const missingJob = await queue.getJob(jobId);
    assert(missingJob);
    await missingJob.remove();
    assert.equal(await queue.getJob(jobId), undefined);

    const coordinator = createPollCoordinator({
      store,
      scheduler,
      batchSize: 20
    });
    await coordinator();
    assert(await queue.getJob(jobId));

    const worker = createPollWorker(queueName, poll);
    try {
      await waitFor(async () => {
        const current = await prisma.videoTask.findUniqueOrThrow({
          where: { id: task.id }
        });
        return current.pollVersion === 4 ? current : null;
      });
      await queue.add(
        "provider-poll",
        { kind: "provider-poll", taskId: task.id, pollVersion: 3 },
        { jobId: `${prefix}-lost-stale`, removeOnComplete: true }
      );
      await waitForQueueIdle(queue);
    } finally {
      await worker.close();
    }

    assert.equal(getCalls, 1);
    assert.equal(createCalls, 0);
    return {
      restoredJobId: jobId,
      providerQueries: getCalls,
      createCalls,
      staleVersionIgnored: true
    };
  } finally {
    await queue.close();
  }
}

async function verifyProcessRestartRecovery(prisma, redis, prefix, queueNames) {
  const queueName = `${prefix}-restart`;
  queueNames.push(queueName);
  const queue = new Queue(queueName, { connection: redis });
  await queue.pause();
  const task = await createScheduledTask(prisma, {
    clientRequestId: `${prefix}-restart`,
    providerTaskId: `${prefix}-provider-restart`,
    version: 7,
    due: new Date(Date.now() - 500),
    deadline: new Date(Date.now() + 60_000)
  });
  const jobId = providerJobId({
    kind: "provider-poll",
    taskId: task.id,
    pollVersion: 7
  });
  assert.equal(await queue.getJob(jobId), undefined);

  try {
    await spawnRecoveryProcess(queueName, 7);
    const restored = await queue.getJob(jobId);
    assert(restored, "Fresh Worker coordinator process did not restore job.");
    assert.equal(restored.data.pollVersion, 7);

    let getCalls = 0;
    let createCalls = 0;
    const scheduler = new BullMqProviderJobScheduler(queue);
    const poll = createPollProcessor({
      store: new PrismaTaskStore(prisma),
      scheduler,
      provider: fixtureProvider({
        create: () => {
          createCalls += 1;
        },
        get: async (providerTaskId) => {
          getCalls += 1;
          return processingSnapshot(providerTaskId);
        }
      }),
      policy: {
        ...policy,
        baseIntervalMs: 30_000,
        maxIntervalMs: 30_000
      },
      random: () => 0.5
    });
    const worker = createPollWorker(queueName, poll);
    await queue.resume();
    try {
      await waitFor(async () => {
        const current = await prisma.videoTask.findUniqueOrThrow({
          where: { id: task.id }
        });
        return current.pollVersion === 8 ? current : null;
      });
    } finally {
      await worker.close();
    }
    assert.equal(getCalls, 1);
    assert.equal(createCalls, 0);

    return {
      restoredJobId: jobId,
      restoredVersion: 7,
      resultingVersion: 8,
      providerQueries: getCalls,
      createCalls
    };
  } finally {
    await queue.close();
  }
}

function createPollWorker(queueName, poll) {
  return new Worker(
    queueName,
    async (job) => {
      if (job.data.kind === "provider-poll") {
        await poll(job.data.taskId, job.data.pollVersion);
      }
    },
    { connection: createRedis(), concurrency: 1 }
  );
}

async function createScheduledTask(
  prisma,
  {
    clientRequestId,
    providerTaskId,
    version,
    due,
    deadline,
    status = TaskStatus.PROCESSING,
    downloadPending = false
  }
) {
  return prisma.videoTask.create({
    data: {
      clientRequestId,
      provider: "mock",
      providerTaskId,
      model: "mock-video-v1",
      status,
      prompt: "Infrastructure scheduling fixture",
      parameters: {
        ratio: "16:9",
        resolution: "720p",
        duration: "5",
        scenario: "slow",
        includeUsage: false
      },
      submittedAt: new Date(),
      pollStartedAt: new Date(),
      nextPollAt: due,
      pollDeadlineAt: deadline,
      pollVersion: version,
      downloadPending
    }
  });
}

function fixtureProvider({ create, get }) {
  return {
    name: "mock",
    createTask: async () => {
      create();
      throw new Error("createTask must not be called in this fixture.");
    },
    recoverTask: async () => null,
    getTask: get
  };
}

function processingSnapshot(providerTaskId) {
  return {
    providerTaskId,
    status: "PROCESSING",
    outputs: [],
    usage: [],
    debug: { providerStatus: "running" }
  };
}

function succeededSnapshot(providerTaskId) {
  return {
    providerTaskId,
    status: "SUCCEEDED",
    outputs: [{ kind: "video", available: true }],
    usage: [],
    debug: { providerStatus: "succeeded" }
  };
}

function createRedis() {
  const connection = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true
  });
  redisConnections.add(connection);
  return connection;
}

async function spawnRecoveryProcess(queueName, version) {
  const scriptPath = fileURLToPath(import.meta.url);
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      [scriptPath, "recover", queueName, `${version}`],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else
        rejectPromise(new Error(`Recovery child failed (${code}): ${stderr}`));
    });
  });
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

async function waitForQueueIdle(queue) {
  await waitFor(async () => {
    const counts = await queue.getJobCounts("active", "waiting", "prioritized");
    return counts.active === 0 &&
      counts.waiting === 0 &&
      counts.prioritized === 0
      ? true
      : null;
  });
}

function delay(milliseconds) {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds)
  );
}

function disconnectRedisConnections() {
  for (const connection of redisConnections) {
    if (connection.status !== "end") connection.disconnect();
  }
}
