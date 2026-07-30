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

export interface VideoGenerationJob {
  taskId: string;
}
