import type { Queue } from "bullmq";
import { describe, expect, it, vi } from "vitest";

import type { VideoGenerationJob } from "@seedance/shared";

import { BullMqProviderJobScheduler } from "./job-scheduler.js";

describe("BullMQ Provider job scheduling", () => {
  it("uses deterministic versioned IDs and a calculated delay", async () => {
    const add = vi.fn(async () => ({}));
    const queue = { add } as unknown as Queue<VideoGenerationJob>;
    const scheduler = new BullMqProviderJobScheduler(
      queue,
      () => new Date("2026-07-31T00:00:00.000Z")
    );

    await scheduler.schedulePoll(
      "task-1",
      4,
      new Date("2026-07-31T00:00:03.000Z")
    );
    await scheduler.scheduleDownload("task-1");

    expect(add).toHaveBeenNthCalledWith(
      1,
      "provider-poll",
      {
        kind: "provider-poll",
        taskId: "task-1",
        pollVersion: 4
      },
      expect.objectContaining({
        jobId: "provider-poll-task-1-v4",
        delay: 3_000,
        attempts: 1
      })
    );
    expect(add).toHaveBeenNthCalledWith(
      2,
      "provider-download",
      {
        kind: "provider-download",
        taskId: "task-1"
      },
      expect.objectContaining({
        jobId: "provider-download-task-1",
        attempts: 1
      })
    );
  });
});
