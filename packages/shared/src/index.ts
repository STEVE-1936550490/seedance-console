export type ServiceStatus = "up" | "down";

export interface ServiceHealth {
  status: ServiceStatus;
  message?: string;
}

export interface HealthResponse {
  status: "ok" | "degraded";
  checkedAt: string;
  services: {
    api: ServiceHealth;
    worker: ServiceHealth;
    postgres: ServiceHealth;
    redis: ServiceHealth;
  };
}

export type TaskStatus =
  | "DRAFT"
  | "QUEUED"
  | "SUBMITTING"
  | "PROCESSING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "EXPIRED";

export interface UsageDto {
  metric: string;
  quantity: string;
  unit: string;
}

export interface TaskDto {
  id: string;
  clientRequestId: string;
  provider: string;
  providerTaskId: string | null;
  model: string;
  status: TaskStatus;
  prompt: string;
  parameters: Record<string, unknown>;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  completedAt: string | null;
  referenceAssets: readonly {
    id: string;
    originalName: string;
    mimeType: string;
  }[];
  usage: readonly UsageDto[];
  hasVideo: boolean;
}

export interface TaskListResponse {
  tasks: readonly TaskDto[];
}

export const videoQueueName = "video-generation";

export interface ProviderSubmitJob {
  kind: "provider-submit";
  taskId: string;
}

export interface ProviderPollJob {
  kind: "provider-poll";
  taskId: string;
  pollVersion: number;
}

export interface ProviderDownloadJob {
  kind: "provider-download";
  taskId: string;
}

export type VideoGenerationJob =
  ProviderSubmitJob | ProviderPollJob | ProviderDownloadJob;

export function parseVideoGenerationJob(value: unknown): VideoGenerationJob {
  if (!isRecord(value) || typeof value.taskId !== "string") {
    throw new Error("Invalid Provider job payload.");
  }
  if (value.kind === "provider-submit" || value.kind === "provider-download") {
    return { kind: value.kind, taskId: requireTaskId(value.taskId) };
  }
  if (
    value.kind === "provider-poll" &&
    Number.isSafeInteger(value.pollVersion) &&
    Number(value.pollVersion) > 0
  ) {
    return {
      kind: value.kind,
      taskId: requireTaskId(value.taskId),
      pollVersion: Number(value.pollVersion)
    };
  }
  throw new Error("Invalid Provider job payload.");
}

export function providerJobId(job: VideoGenerationJob): string {
  switch (job.kind) {
    case "provider-submit":
      return `provider-submit-${job.taskId}`;
    case "provider-poll":
      return `provider-poll-${job.taskId}-v${job.pollVersion}`;
    case "provider-download":
      return `provider-download-${job.taskId}`;
  }
}

function requireTaskId(value: string): string {
  const taskId = value.trim();
  if (taskId.length === 0 || taskId.length > 128) {
    throw new Error("Invalid Provider job task ID.");
  }
  return taskId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
