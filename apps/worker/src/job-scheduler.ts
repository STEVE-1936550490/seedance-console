import type { Queue } from "bullmq";

import {
  providerJobId,
  type ProviderDownloadJob,
  type ProviderPollJob,
  type VideoGenerationJob
} from "@seedance/shared";

export interface ProviderJobScheduler {
  schedulePoll(taskId: string, pollVersion: number, runAt: Date): Promise<void>;
  scheduleDownload(
    taskId: string,
    providerTaskId: string,
    downloadVersion: number,
    runAt: Date
  ): Promise<void>;
}

export class BullMqProviderJobScheduler implements ProviderJobScheduler {
  constructor(
    private readonly queue: Queue<VideoGenerationJob>,
    private readonly now: () => Date = () => new Date()
  ) {}

  async schedulePoll(
    taskId: string,
    pollVersion: number,
    runAt: Date
  ): Promise<void> {
    const job: ProviderPollJob = {
      kind: "provider-poll",
      taskId,
      pollVersion
    };
    await this.queue.add(job.kind, job, {
      jobId: providerJobId(job),
      delay: Math.max(0, runAt.getTime() - this.now().getTime()),
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true
    });
  }

  async scheduleDownload(
    taskId: string,
    providerTaskId: string,
    downloadVersion: number,
    runAt: Date
  ): Promise<void> {
    const job: ProviderDownloadJob = {
      kind: "provider-download",
      taskId,
      providerTaskId,
      downloadVersion
    };
    await this.queue.add(job.kind, job, {
      jobId: providerJobId(job),
      delay: Math.max(0, runAt.getTime() - this.now().getTime()),
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true
    });
  }
}
