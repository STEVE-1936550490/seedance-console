import {
  AssetKind,
  AssetRole,
  Prisma,
  ProviderSubmissionStatus,
  TaskStatus,
  type PrismaClient
} from "@prisma/client";
import type { ProviderUsage } from "@seedance/seedance-provider";

export interface SubmissionTask {
  id: string;
  provider: string;
  clientRequestId: string;
  providerTaskId: string | null;
  status: TaskStatus;
  model: string;
  prompt: string;
  parameters: Prisma.JsonValue;
  referenceAssetIds: readonly string[];
  recoveredProviderTaskId: string | null;
}

export interface InitialPollSchedule {
  now: Date;
  nextPollAt: Date;
  pollDeadlineAt: Date;
  pollVersion: number;
}

export interface PollClaim {
  taskId: string;
  providerTaskId: string;
  pollVersion: number;
  pollAttempt: number;
  transientErrors: number;
  pollDeadlineAt: Date;
  leaseUntil: Date;
}

export interface NextPollSchedule {
  now: Date;
  nextPollAt: Date;
  providerStatus?: string;
  transientErrors: number;
  lastPollError?: string;
}

export interface RecoverablePoll {
  taskId: string;
  pollVersion: number;
  nextPollAt: Date;
}

export interface DownloadSchedule {
  taskId: string;
  providerTaskId: string;
  downloadVersion: number;
  nextDownloadAt: Date;
}

export interface DownloadClaim {
  taskId: string;
  providerTaskId: string;
  downloadVersion: number;
  downloadAttempt: number;
  downloadErrors: number;
  downloadDeadlineAt: Date;
  leaseUntil: Date;
}

export interface VideoOutputMetadata {
  storageKey: string;
  sha256: string;
  fileSize: number;
  mimeType: string;
}

export interface StoredVideoOutput extends VideoOutputMetadata {
  assetId: string;
}

export interface TaskStore {
  loadSubmissionTask(taskId: string): Promise<SubmissionTask | null>;
  claimSubmission(task: SubmissionTask): Promise<boolean>;
  acceptSubmission(
    task: SubmissionTask,
    providerTaskId: string,
    schedule: InitialPollSchedule
  ): Promise<boolean>;
  markSubmissionOutcomeUnknown(task: SubmissionTask): Promise<void>;
  claimPoll(
    taskId: string,
    pollVersion: number,
    now: Date,
    leaseUntil: Date
  ): Promise<PollClaim | null>;
  scheduleNextPoll(
    claim: PollClaim,
    schedule: NextPollSchedule
  ): Promise<boolean>;
  markDownloadPending(
    claim: PollClaim,
    now: Date,
    downloadDeadlineAt: Date,
    providerName: string,
    usage: readonly ProviderUsage[],
    providerStatus?: string
  ): Promise<DownloadSchedule | null>;
  markProviderFailed(
    claim: PollClaim,
    now: Date,
    errorCode: string,
    errorMessage: string,
    providerStatus?: string
  ): Promise<boolean>;
  stopPollingForManualReview(
    claim: PollClaim,
    now: Date,
    errorCode: string
  ): Promise<boolean>;
  expireLocalPoll(claim: PollClaim, now: Date): Promise<boolean>;
  findRecoverablePolls(
    now: Date,
    limit: number
  ): Promise<readonly RecoverablePoll[]>;
  findPendingDownloads(
    now: Date,
    limit: number
  ): Promise<readonly DownloadSchedule[]>;
  claimDownload(
    taskId: string,
    providerTaskId: string,
    downloadVersion: number,
    now: Date,
    leaseUntil: Date
  ): Promise<DownloadClaim | null>;
  loadVideoOutput(taskId: string): Promise<StoredVideoOutput | null>;
  persistVideoOutputAndComplete(
    claim: DownloadClaim,
    output: VideoOutputMetadata,
    now: Date
  ): Promise<boolean>;
  invalidateVideoOutput(claim: DownloadClaim): Promise<string | null>;
  scheduleDownloadRetry(
    claim: DownloadClaim,
    now: Date,
    nextDownloadAt: Date,
    errorCode: string
  ): Promise<boolean>;
  stopDownload(
    claim: DownloadClaim,
    now: Date,
    errorCode: string,
    errorMessage: string
  ): Promise<boolean>;
}

export class PrismaTaskStore implements TaskStore {
  constructor(private readonly prisma: PrismaClient) {}

  async loadSubmissionTask(taskId: string): Promise<SubmissionTask | null> {
    const task = await this.prisma.videoTask.findUnique({
      where: { id: taskId },
      include: {
        submission: true,
        assets: {
          where: { role: AssetRole.REFERENCE_IMAGE },
          select: { assetId: true }
        }
      }
    });
    if (task === null) return null;
    return {
      id: task.id,
      provider: task.provider,
      clientRequestId: task.clientRequestId,
      providerTaskId: task.providerTaskId,
      status: task.status,
      model: task.model,
      prompt: task.prompt,
      parameters: task.parameters,
      referenceAssetIds: task.assets.map((asset) => asset.assetId),
      recoveredProviderTaskId: task.submission?.providerTaskId ?? null
    };
  }

  claimSubmission(task: SubmissionTask): Promise<boolean> {
    return this.prisma.$transaction(async (transaction) => {
      const claimed = await transaction.videoTask.updateMany({
        where: {
          id: task.id,
          status: TaskStatus.QUEUED,
          providerTaskId: null
        },
        data: { status: TaskStatus.SUBMITTING }
      });
      if (claimed.count !== 1) return false;
      await transaction.providerSubmission.upsert({
        where: { taskId: task.id },
        create: {
          taskId: task.id,
          provider: task.provider,
          clientRequestId: task.clientRequestId,
          status: ProviderSubmissionStatus.ATTEMPTING
        },
        update: {
          status: ProviderSubmissionStatus.ATTEMPTING,
          errorCode: null
        }
      });
      await transaction.taskEvent.create({
        data: {
          taskId: task.id,
          fromStatus: TaskStatus.QUEUED,
          toStatus: TaskStatus.SUBMITTING,
          reason: "WORKER_STARTED"
        }
      });
      return true;
    });
  }

  acceptSubmission(
    task: SubmissionTask,
    providerTaskId: string,
    schedule: InitialPollSchedule
  ): Promise<boolean> {
    return this.prisma.$transaction(async (transaction) => {
      const accepted = await transaction.videoTask.updateMany({
        where: {
          id: task.id,
          status: TaskStatus.SUBMITTING,
          providerTaskId: null
        },
        data: {
          status: TaskStatus.PROCESSING,
          providerTaskId,
          submittedAt: schedule.now,
          pollStartedAt: schedule.now,
          nextPollAt: schedule.nextPollAt,
          pollDeadlineAt: schedule.pollDeadlineAt,
          pollLeaseUntil: null,
          pollVersion: schedule.pollVersion,
          pollAttempt: 0,
          pollTransientErrors: 0,
          lastProviderStatus: null,
          lastPollError: null,
          downloadPending: false,
          errorCode: null,
          errorMessage: null
        }
      });
      await transaction.providerSubmission.upsert({
        where: { taskId: task.id },
        create: {
          taskId: task.id,
          provider: task.provider,
          clientRequestId: task.clientRequestId,
          providerTaskId,
          status: ProviderSubmissionStatus.ACCEPTED,
          acceptedAt: schedule.now
        },
        update: {
          providerTaskId,
          status: ProviderSubmissionStatus.ACCEPTED,
          acceptedAt: schedule.now,
          errorCode: null
        }
      });
      if (accepted.count !== 1) return false;
      await transaction.taskEvent.create({
        data: {
          taskId: task.id,
          fromStatus: TaskStatus.SUBMITTING,
          toStatus: TaskStatus.PROCESSING,
          reason: "PROVIDER_ACCEPTED"
        }
      });
      return true;
    });
  }

  async markSubmissionOutcomeUnknown(task: SubmissionTask): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const marked = await transaction.videoTask.updateMany({
        where: {
          id: task.id,
          status: TaskStatus.SUBMITTING,
          providerTaskId: null
        },
        data: {
          errorCode: "PROVIDER_CREATE_OUTCOME_UNKNOWN",
          errorMessage:
            "Provider create outcome is unknown; automatic resubmission is disabled."
        }
      });
      if (marked.count !== 1) return;
      await transaction.providerSubmission.upsert({
        where: { taskId: task.id },
        create: {
          taskId: task.id,
          provider: task.provider,
          clientRequestId: task.clientRequestId,
          status: ProviderSubmissionStatus.OUTCOME_UNKNOWN,
          errorCode: "PROVIDER_CREATE_OUTCOME_UNKNOWN"
        },
        update: {
          status: ProviderSubmissionStatus.OUTCOME_UNKNOWN,
          errorCode: "PROVIDER_CREATE_OUTCOME_UNKNOWN"
        }
      });
      await transaction.taskEvent.create({
        data: {
          taskId: task.id,
          fromStatus: TaskStatus.SUBMITTING,
          toStatus: TaskStatus.SUBMITTING,
          reason: "PROVIDER_CREATE_OUTCOME_UNKNOWN"
        }
      });
    });
  }

  async claimPoll(
    taskId: string,
    pollVersion: number,
    now: Date,
    leaseUntil: Date
  ): Promise<PollClaim | null> {
    const task = await this.prisma.videoTask.findUnique({
      where: { id: taskId },
      select: {
        providerTaskId: true,
        status: true,
        pollVersion: true,
        pollAttempt: true,
        pollTransientErrors: true,
        pollDeadlineAt: true,
        nextPollAt: true
      }
    });
    if (
      task === null ||
      task.status !== TaskStatus.PROCESSING ||
      task.providerTaskId === null ||
      task.pollVersion !== pollVersion ||
      task.pollDeadlineAt === null ||
      task.nextPollAt === null ||
      task.nextPollAt > now
    ) {
      return null;
    }
    const claimed = await this.prisma.videoTask.updateMany({
      where: {
        id: taskId,
        status: TaskStatus.PROCESSING,
        providerTaskId: task.providerTaskId,
        pollVersion,
        nextPollAt: { lte: now },
        downloadPending: false,
        OR: [{ pollLeaseUntil: null }, { pollLeaseUntil: { lte: now } }]
      },
      data: { pollLeaseUntil: leaseUntil }
    });
    if (claimed.count !== 1) return null;
    return {
      taskId,
      providerTaskId: task.providerTaskId,
      pollVersion,
      pollAttempt: task.pollAttempt,
      transientErrors: task.pollTransientErrors,
      pollDeadlineAt: task.pollDeadlineAt,
      leaseUntil
    };
  }

  async scheduleNextPoll(
    claim: PollClaim,
    schedule: NextPollSchedule
  ): Promise<boolean> {
    const updated = await this.prisma.videoTask.updateMany({
      where: pollClaimWhere(claim),
      data: {
        pollVersion: { increment: 1 },
        pollAttempt: { increment: 1 },
        pollTransientErrors: schedule.transientErrors,
        nextPollAt: schedule.nextPollAt,
        lastPolledAt: schedule.now,
        pollLeaseUntil: null,
        lastProviderStatus: schedule.providerStatus ?? null,
        lastPollError: schedule.lastPollError ?? null
      }
    });
    return updated.count === 1;
  }

  async markDownloadPending(
    claim: PollClaim,
    now: Date,
    downloadDeadlineAt: Date,
    providerName: string,
    usage: readonly ProviderUsage[],
    providerStatus?: string
  ): Promise<DownloadSchedule | null> {
    return this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.videoTask.updateMany({
        where: pollClaimWhere(claim),
        data: {
          pollAttempt: { increment: 1 },
          nextPollAt: null,
          lastPolledAt: now,
          pollLeaseUntil: null,
          lastProviderStatus: providerStatus ?? null,
          lastPollError: null,
          downloadPending: true,
          downloadStartedAt: now,
          nextDownloadAt: now,
          downloadDeadlineAt,
          downloadLeaseUntil: null,
          downloadVersion: 1,
          downloadAttempt: 0,
          downloadErrors: 0,
          lastDownloadAt: null,
          lastDownloadError: null
        }
      });
      if (updated.count !== 1) return null;
      if (usage.length > 0) {
        await transaction.usageRecord.createMany({
          data: usage.map((record) => ({
            taskId: claim.taskId,
            provider: providerName,
            metric: record.metric,
            quantity: new Prisma.Decimal(record.quantity),
            unit: record.unit,
            raw: {
              source: providerName,
              testOnly: providerName === "mock"
            }
          }))
        });
      }
      await transaction.taskEvent.create({
        data: {
          taskId: claim.taskId,
          fromStatus: TaskStatus.PROCESSING,
          toStatus: TaskStatus.PROCESSING,
          reason: "PROVIDER_OUTPUT_READY"
        }
      });
      return {
        taskId: claim.taskId,
        providerTaskId: claim.providerTaskId,
        downloadVersion: 1,
        nextDownloadAt: now
      };
    });
  }

  async markProviderFailed(
    claim: PollClaim,
    now: Date,
    errorCode: string,
    errorMessage: string,
    providerStatus?: string
  ): Promise<boolean> {
    return this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.videoTask.updateMany({
        where: pollClaimWhere(claim),
        data: {
          status: TaskStatus.FAILED,
          completedAt: now,
          pollAttempt: { increment: 1 },
          nextPollAt: null,
          lastPolledAt: now,
          pollLeaseUntil: null,
          lastProviderStatus: providerStatus ?? null,
          lastPollError: null,
          errorCode,
          errorMessage
        }
      });
      if (updated.count !== 1) return false;
      await transaction.taskEvent.create({
        data: {
          taskId: claim.taskId,
          fromStatus: TaskStatus.PROCESSING,
          toStatus: TaskStatus.FAILED,
          reason: errorCode
        }
      });
      return true;
    });
  }

  async stopPollingForManualReview(
    claim: PollClaim,
    now: Date,
    errorCode: string
  ): Promise<boolean> {
    return this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.videoTask.updateMany({
        where: pollClaimWhere(claim),
        data: {
          pollAttempt: { increment: 1 },
          nextPollAt: null,
          lastPolledAt: now,
          pollLeaseUntil: null,
          lastPollError: errorCode,
          errorCode,
          errorMessage: "Automatic polling stopped; manual review is required."
        }
      });
      if (updated.count !== 1) return false;
      await transaction.taskEvent.create({
        data: {
          taskId: claim.taskId,
          fromStatus: TaskStatus.PROCESSING,
          toStatus: TaskStatus.PROCESSING,
          reason: errorCode
        }
      });
      return true;
    });
  }

  async expireLocalPoll(claim: PollClaim, now: Date): Promise<boolean> {
    return this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.videoTask.updateMany({
        where: pollClaimWhere(claim),
        data: {
          status: TaskStatus.EXPIRED,
          completedAt: now,
          nextPollAt: null,
          lastPolledAt: now,
          pollLeaseUntil: null,
          lastPollError: "LOCAL_POLL_DEADLINE_EXCEEDED",
          errorCode: "LOCAL_POLL_DEADLINE_EXCEEDED",
          errorMessage:
            "Local polling deadline exceeded; the remote task state is unknown."
        }
      });
      if (updated.count !== 1) return false;
      await transaction.taskEvent.create({
        data: {
          taskId: claim.taskId,
          fromStatus: TaskStatus.PROCESSING,
          toStatus: TaskStatus.EXPIRED,
          reason: "LOCAL_POLL_DEADLINE_EXCEEDED"
        }
      });
      return true;
    });
  }

  async findRecoverablePolls(
    now: Date,
    limit: number
  ): Promise<readonly RecoverablePoll[]> {
    const tasks = await this.prisma.videoTask.findMany({
      where: {
        status: TaskStatus.PROCESSING,
        providerTaskId: { not: null },
        downloadPending: false,
        nextPollAt: { lte: now },
        OR: [{ pollLeaseUntil: null }, { pollLeaseUntil: { lte: now } }]
      },
      select: { id: true, pollVersion: true, nextPollAt: true },
      orderBy: { nextPollAt: "asc" },
      take: limit
    });
    return tasks.flatMap((task) =>
      task.nextPollAt === null || task.pollVersion <= 0
        ? []
        : [
            {
              taskId: task.id,
              pollVersion: task.pollVersion,
              nextPollAt: task.nextPollAt
            }
          ]
    );
  }

  async findPendingDownloads(
    now: Date,
    limit: number
  ): Promise<readonly DownloadSchedule[]> {
    const tasks = await this.prisma.videoTask.findMany({
      where: {
        status: TaskStatus.PROCESSING,
        providerTaskId: { not: null },
        downloadPending: true,
        downloadVersion: { gt: 0 },
        nextDownloadAt: { lte: now },
        OR: [{ downloadLeaseUntil: null }, { downloadLeaseUntil: { lte: now } }]
      },
      select: {
        id: true,
        providerTaskId: true,
        downloadVersion: true,
        nextDownloadAt: true
      },
      orderBy: { nextDownloadAt: "asc" },
      take: limit
    });
    return tasks.flatMap((task) =>
      task.providerTaskId === null || task.nextDownloadAt === null
        ? []
        : [
            {
              taskId: task.id,
              providerTaskId: task.providerTaskId,
              downloadVersion: task.downloadVersion,
              nextDownloadAt: task.nextDownloadAt
            }
          ]
    );
  }

  async claimDownload(
    taskId: string,
    providerTaskId: string,
    downloadVersion: number,
    now: Date,
    leaseUntil: Date
  ): Promise<DownloadClaim | null> {
    const task = await this.prisma.videoTask.findUnique({
      where: { id: taskId },
      select: {
        status: true,
        providerTaskId: true,
        downloadPending: true,
        downloadVersion: true,
        downloadAttempt: true,
        downloadErrors: true,
        downloadDeadlineAt: true,
        nextDownloadAt: true
      }
    });
    if (
      task === null ||
      task.status !== TaskStatus.PROCESSING ||
      !task.downloadPending ||
      task.providerTaskId !== providerTaskId ||
      task.downloadVersion !== downloadVersion ||
      task.downloadDeadlineAt === null ||
      task.nextDownloadAt === null ||
      task.nextDownloadAt > now
    ) {
      return null;
    }
    const claimed = await this.prisma.videoTask.updateMany({
      where: {
        id: taskId,
        status: TaskStatus.PROCESSING,
        providerTaskId,
        downloadPending: true,
        downloadVersion,
        nextDownloadAt: { lte: now },
        OR: [{ downloadLeaseUntil: null }, { downloadLeaseUntil: { lte: now } }]
      },
      data: { downloadLeaseUntil: leaseUntil }
    });
    if (claimed.count !== 1) return null;
    return {
      taskId,
      providerTaskId,
      downloadVersion,
      downloadAttempt: task.downloadAttempt,
      downloadErrors: task.downloadErrors,
      downloadDeadlineAt: task.downloadDeadlineAt,
      leaseUntil
    };
  }

  async loadVideoOutput(taskId: string): Promise<StoredVideoOutput | null> {
    const output = await this.prisma.videoOutput.findUnique({
      where: { taskId }
    });
    return output === null
      ? null
      : {
          assetId: output.assetId,
          storageKey: output.storageKey,
          sha256: output.sha256,
          fileSize: Number(output.fileSize),
          mimeType: output.mimeType
        };
  }

  persistVideoOutputAndComplete(
    claim: DownloadClaim,
    output: VideoOutputMetadata,
    now: Date
  ): Promise<boolean> {
    return this.prisma.$transaction(async (transaction) => {
      const asset = await transaction.asset.upsert({
        where: { storageKey: output.storageKey },
        create: {
          kind: AssetKind.OUTPUT_VIDEO,
          storageKey: output.storageKey,
          originalName: `${claim.taskId}.mp4`,
          mimeType: output.mimeType,
          sizeBytes: output.fileSize,
          checksum: output.sha256
        },
        update: {
          mimeType: output.mimeType,
          sizeBytes: output.fileSize,
          checksum: output.sha256
        }
      });
      await transaction.taskAsset.upsert({
        where: {
          taskId_assetId_role: {
            taskId: claim.taskId,
            assetId: asset.id,
            role: AssetRole.GENERATED_VIDEO
          }
        },
        create: {
          taskId: claim.taskId,
          assetId: asset.id,
          role: AssetRole.GENERATED_VIDEO
        },
        update: {}
      });
      await transaction.videoOutput.upsert({
        where: { taskId: claim.taskId },
        create: {
          taskId: claim.taskId,
          assetId: asset.id,
          providerTaskId: claim.providerTaskId,
          ...output
        },
        update: {
          assetId: asset.id,
          providerTaskId: claim.providerTaskId,
          ...output
        }
      });
      const completed = await transaction.videoTask.updateMany({
        where: downloadClaimWhere(claim),
        data: {
          status: TaskStatus.SUCCEEDED,
          downloadPending: false,
          nextDownloadAt: null,
          downloadLeaseUntil: null,
          lastDownloadAt: now,
          lastDownloadError: null,
          completedAt: now,
          errorCode: null,
          errorMessage: null
        }
      });
      if (completed.count !== 1) {
        throw new TaskNoLongerDownloadableError();
      }
      await transaction.taskEvent.create({
        data: {
          taskId: claim.taskId,
          fromStatus: TaskStatus.PROCESSING,
          toStatus: TaskStatus.SUCCEEDED,
          reason: "OUTPUT_STORED"
        }
      });
      return true;
    });
  }

  invalidateVideoOutput(claim: DownloadClaim): Promise<string | null> {
    return this.prisma.$transaction(async (transaction) => {
      const active = await transaction.videoTask.count({
        where: downloadClaimWhere(claim)
      });
      if (active !== 1) return null;
      const output = await transaction.videoOutput.findUnique({
        where: { taskId: claim.taskId }
      });
      if (output === null) return null;
      await transaction.videoOutput.delete({ where: { id: output.id } });
      await transaction.taskAsset.deleteMany({
        where: {
          taskId: claim.taskId,
          assetId: output.assetId,
          role: AssetRole.GENERATED_VIDEO
        }
      });
      await transaction.asset.delete({ where: { id: output.assetId } });
      return output.storageKey;
    });
  }

  async scheduleDownloadRetry(
    claim: DownloadClaim,
    now: Date,
    nextDownloadAt: Date,
    errorCode: string
  ): Promise<boolean> {
    const updated = await this.prisma.videoTask.updateMany({
      where: downloadClaimWhere(claim),
      data: {
        downloadVersion: { increment: 1 },
        downloadAttempt: { increment: 1 },
        downloadErrors: { increment: 1 },
        nextDownloadAt,
        downloadLeaseUntil: null,
        lastDownloadAt: now,
        lastDownloadError: errorCode,
        errorCode,
        errorMessage: "Video download will be retried."
      }
    });
    return updated.count === 1;
  }

  stopDownload(
    claim: DownloadClaim,
    now: Date,
    errorCode: string,
    errorMessage: string
  ): Promise<boolean> {
    return this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.videoTask.updateMany({
        where: downloadClaimWhere(claim),
        data: {
          downloadAttempt: { increment: 1 },
          nextDownloadAt: null,
          downloadLeaseUntil: null,
          lastDownloadAt: now,
          lastDownloadError: errorCode,
          errorCode,
          errorMessage
        }
      });
      if (updated.count !== 1) return false;
      await transaction.taskEvent.create({
        data: {
          taskId: claim.taskId,
          fromStatus: TaskStatus.PROCESSING,
          toStatus: TaskStatus.PROCESSING,
          reason: errorCode
        }
      });
      return true;
    });
  }
}

function pollClaimWhere(claim: PollClaim) {
  return {
    id: claim.taskId,
    status: TaskStatus.PROCESSING,
    providerTaskId: claim.providerTaskId,
    pollVersion: claim.pollVersion,
    pollLeaseUntil: claim.leaseUntil,
    downloadPending: false
  } satisfies Prisma.VideoTaskWhereInput;
}

function downloadClaimWhere(claim: DownloadClaim) {
  return {
    id: claim.taskId,
    status: TaskStatus.PROCESSING,
    providerTaskId: claim.providerTaskId,
    downloadPending: true,
    downloadVersion: claim.downloadVersion,
    downloadLeaseUntil: claim.leaseUntil
  } satisfies Prisma.VideoTaskWhereInput;
}

class TaskNoLongerDownloadableError extends Error {}
