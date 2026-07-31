import type { ProviderJobScheduler } from "./job-scheduler.js";
import type { TaskStore } from "./task-store.js";

export interface PollCoordinatorDependencies {
  store: TaskStore;
  scheduler: ProviderJobScheduler;
  batchSize: number;
  now?: () => Date;
}

export function createPollCoordinator(
  dependencies: PollCoordinatorDependencies
) {
  const now = dependencies.now ?? (() => new Date());
  return async (): Promise<void> => {
    const currentTime = now();
    const [polls, downloads] = await Promise.all([
      dependencies.store.findRecoverablePolls(
        currentTime,
        dependencies.batchSize
      ),
      dependencies.store.findPendingDownloads(dependencies.batchSize)
    ]);
    await Promise.all([
      ...polls.map((poll) =>
        dependencies.scheduler.schedulePoll(
          poll.taskId,
          poll.pollVersion,
          poll.nextPollAt
        )
      ),
      ...downloads.map((taskId) =>
        dependencies.scheduler.scheduleDownload(taskId)
      )
    ]);
  };
}
