import { createHash } from "node:crypto";
import { createReadStream, statSync, type ReadStream } from "node:fs";
import { fileURLToPath } from "node:url";

import { ProviderProtocolError } from "./errors.js";
import type {
  CreateTaskInput,
  MockParameters,
  ProviderCapabilities,
  ProviderDefinition,
  ProviderDownload,
  ProviderRuntime,
  ProviderTaskSnapshot,
  ValidationResult
} from "./types.js";

const modelId = "mock-video-v1";

const capabilities: ProviderCapabilities = {
  provider: "mock",
  label: "Mock Video",
  testOnly: true,
  supportsCancellation: true,
  supportsReferenceImage: true,
  maxReferenceImages: 8,
  supportsReferenceVideo: true,
  maxReferenceVideos: 1,
  acceptedAssetTypes: ["image", "video"],
  models: [
    {
      id: modelId,
      label: "Mock Video V1",
      description: "本地测试模型，不会调用任何外部服务。",
      parameters: [
        {
          key: "ratio",
          label: "视频比例",
          description: "Mock 输出的画面比例标签。",
          type: "select",
          required: true,
          defaultValue: "16:9",
          options: [
            { label: "横屏 16:9", value: "16:9" },
            { label: "竖屏 9:16", value: "9:16" },
            { label: "方形 1:1", value: "1:1" }
          ],
          group: "primary"
        },
        {
          key: "resolution",
          label: "分辨率",
          description: "仅用于验证动态参数和任务记录。",
          type: "select",
          required: true,
          defaultValue: "720p",
          options: [
            { label: "720p", value: "720p" },
            { label: "1080p", value: "1080p" }
          ],
          group: "primary"
        },
        {
          key: "duration",
          label: "时长",
          description: "Mock 任务参数，不代表 Seedance 真实限制。",
          type: "select",
          required: true,
          defaultValue: "5",
          options: [
            { label: "5 秒", value: "5" },
            { label: "10 秒", value: "10" }
          ],
          group: "primary"
        },
        {
          key: "scenario",
          label: "测试结果",
          description: "开发专用：验证成功、失败和持续处理状态。",
          type: "select",
          required: true,
          defaultValue: "success",
          options: [
            { label: "生成成功", value: "success" },
            { label: "模拟失败", value: "failure" },
            { label: "持续处理中", value: "slow" }
          ],
          group: "advanced"
        },
        {
          key: "includeUsage",
          label: "返回 Mock 用量",
          description: "写入明确标记为测试数据的用量记录。",
          type: "boolean",
          required: true,
          defaultValue: true,
          group: "advanced"
        }
      ]
    }
  ]
};

interface StoredTask {
  id: string;
  parameters: MockParameters;
  polls: number;
  cancelled: boolean;
}

export class MockProviderError extends Error {
  constructor(
    readonly code: "INVALID_PARAMETERS" | "TASK_NOT_FOUND" | "OUTPUT_NOT_READY",
    message: string
  ) {
    super(message);
    this.name = "MockProviderError";
  }
}

export class MockProviderDefinition implements ProviderDefinition {
  readonly name = "mock" as const;

  async getCapabilities(): Promise<ProviderCapabilities> {
    return capabilities;
  }

  validateParameters(
    model: string,
    parameters: unknown
  ): ValidationResult<MockParameters> {
    if (model !== modelId) {
      return {
        ok: false,
        issues: [
          {
            path: "model",
            code: "UNKNOWN_MODEL",
            message: "Unknown Mock Provider model."
          }
        ]
      };
    }
    if (!isRecord(parameters)) {
      return {
        ok: false,
        issues: [
          {
            path: "parameters",
            code: "INVALID_TYPE",
            message: "Must be an object."
          }
        ]
      };
    }

    const definitions = capabilities.models[0]?.parameters ?? [];
    const allowedKeys = new Set(
      definitions.map((definition) => definition.key)
    );
    const unknownKey = Object.keys(parameters).find(
      (key) => !allowedKeys.has(key)
    );
    if (unknownKey !== undefined) {
      return {
        ok: false,
        issues: [
          {
            path: `parameters.${unknownKey}`,
            code: "UNKNOWN_PARAMETER",
            message: "Unknown Mock Provider parameter."
          }
        ]
      };
    }

    const values = Object.fromEntries(
      definitions.map((definition) => [
        definition.key,
        parameters[definition.key] ?? definition.defaultValue
      ])
    );

    const issues = definitions.flatMap((definition) => {
      const value = values[definition.key];
      if (definition.type === "boolean") {
        return typeof value === "boolean"
          ? []
          : [{ path: definition.key, message: "Must be a boolean." }];
      }
      return definition.options.some((option) => option.value === value)
        ? []
        : [{ path: definition.key, message: "Unsupported option." }];
    });

    if (issues.length > 0) {
      return {
        ok: false,
        issues: issues.map((issue) => ({
          path: `parameters.${issue.path}`,
          code: "UNSUPPORTED_VALUE",
          message: issue.message
        }))
      };
    }

    return { ok: true, value: values as unknown as MockParameters };
  }
}

export class MockSeedanceProvider
  extends MockProviderDefinition
  implements ProviderRuntime
{
  private readonly tasks = new Map<string, StoredTask>();
  private readonly requestIndex = new Map<string, string>();

  async createTask(input: CreateTaskInput): Promise<ProviderTaskSnapshot> {
    const existingId = this.requestIndex.get(input.clientRequestId);
    if (existingId !== undefined) {
      return this.snapshot(this.requireTask(existingId));
    }

    const validation = this.validateParameters(input.model, input.parameters);
    if (!validation.ok) {
      throw new MockProviderError(
        "INVALID_PARAMETERS",
        validation.issues.map((issue) => issue.message).join(" ")
      );
    }

    const id = stableTaskId(input.clientRequestId);
    const task: StoredTask = {
      id,
      parameters: validation.value,
      polls: 0,
      cancelled: false
    };
    this.tasks.set(id, task);
    this.requestIndex.set(input.clientRequestId, id);
    return this.snapshot(task);
  }

  async recoverTask(clientRequestId: string): Promise<string | null> {
    return this.requestIndex.get(clientRequestId) ?? null;
  }

  async getTask(providerTaskId: string): Promise<ProviderTaskSnapshot> {
    const task = this.requireTask(providerTaskId);
    if (!task.cancelled && task.parameters.scenario !== "slow") {
      task.polls += 1;
    }
    return this.snapshot(task);
  }

  async cancelTask(providerTaskId: string): Promise<ProviderTaskSnapshot> {
    const task = this.requireTask(providerTaskId);
    task.cancelled = true;
    return this.snapshot(task);
  }

  normalizeStatus(rawStatus: unknown): ProviderTaskSnapshot["status"] {
    if (
      rawStatus === "PROCESSING" ||
      rawStatus === "SUCCEEDED" ||
      rawStatus === "FAILED" ||
      rawStatus === "CANCELLED" ||
      rawStatus === "EXPIRED"
    ) {
      return rawStatus;
    }
    throw new ProviderProtocolError(
      "NORMALIZE",
      "Mock Provider returned an unknown status."
    );
  }

  normalizeUsage(rawResponse: unknown) {
    if (
      isRecord(rawResponse) &&
      Array.isArray(rawResponse.usage) &&
      rawResponse.usage.every(isMockUsage)
    ) {
      return rawResponse.usage;
    }
    return [];
  }

  async downloadOutput(
    providerTaskId: string,
    output: { kind: "video" }
  ): Promise<ProviderDownload> {
    void output;
    const task = this.requireTask(providerTaskId);
    const snapshot = this.snapshot(task);
    if (snapshot.status !== "SUCCEEDED") {
      throw new MockProviderError(
        "OUTPUT_NOT_READY",
        "Mock Provider output is not ready."
      );
    }
    const path = mockVideoFixturePath();
    return {
      body: createReadStream(path),
      contentType: "video/mp4",
      contentLength: statSync(path).size,
      fileName: `${providerTaskId}.mp4`
    };
  }

  private requireTask(providerTaskId: string): StoredTask {
    const task = this.tasks.get(providerTaskId);
    if (task === undefined) {
      throw new MockProviderError(
        "TASK_NOT_FOUND",
        `Mock task ${providerTaskId} was not found.`
      );
    }
    return task;
  }

  private snapshot(task: StoredTask): ProviderTaskSnapshot {
    if (task.cancelled) {
      return {
        providerTaskId: task.id,
        status: "CANCELLED",
        outputs: [],
        usage: []
      };
    }

    if (task.parameters.scenario === "slow" || task.polls < 2) {
      return {
        providerTaskId: task.id,
        status: "PROCESSING",
        outputs: [],
        usage: []
      };
    }

    if (task.parameters.scenario === "failure") {
      return {
        providerTaskId: task.id,
        status: "FAILED",
        outputs: [],
        usage: [],
        error: {
          code: "MOCK_GENERATION_FAILED",
          message: "Mock Provider 已按测试参数返回失败。",
          retryable: false
        }
      };
    }

    return {
      providerTaskId: task.id,
      status: "SUCCEEDED",
      outputs: [
        {
          kind: "video",
          available: true,
          uri: `mock://videos/${task.id}.mp4`,
          mimeType: "video/mp4"
        }
      ],
      usage: task.parameters.includeUsage
        ? [{ metric: "mock_task", quantity: "1", unit: "mock-unit" }]
        : []
    };
  }
}

export function openMockVideoFixture(): ReadStream {
  return createReadStream(mockVideoFixturePath());
}

function stableTaskId(clientRequestId: string): string {
  const digest = createHash("sha256")
    .update(clientRequestId)
    .digest("hex")
    .slice(0, 16);
  return `mock-task-${digest}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMockUsage(
  value: unknown
): value is { metric: string; quantity: string; unit: string } {
  return (
    isRecord(value) &&
    typeof value.metric === "string" &&
    typeof value.quantity === "string" &&
    typeof value.unit === "string"
  );
}

function mockVideoFixturePath(): string {
  return fileURLToPath(new URL("./fixtures/mock-output.mp4", import.meta.url));
}
