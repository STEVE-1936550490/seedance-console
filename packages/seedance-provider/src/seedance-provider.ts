import { z } from "zod";

import type {
  BridgeCreateVideoTaskRequest,
  BridgeQueryVideoTaskResponse,
  BridgeVideoContent
} from "./bridge-contract.js";
import {
  ProviderProtocolError,
  ProviderUnsupportedOperationError,
  ProviderValidationError
} from "./errors.js";
import type {
  CreateTaskInput,
  ProviderCapabilities,
  ProviderDefinition,
  ProviderDownload,
  ProviderRuntime,
  ProviderTaskSnapshot,
  ProviderTaskStatus,
  ProviderUsage,
  PublishedProviderAsset,
  SeedanceParameters,
  ValidationResult
} from "./types.js";

const seedanceParametersSchema = z
  .object({
    ratio: z.literal("16:9"),
    duration: z.literal(11),
    generateAudio: z.literal(true),
    watermark: z.literal(false)
  })
  .strict();

export interface SeedanceProviderDefinitionOptions {
  modelId: string;
}

export class SeedanceProviderDefinition implements ProviderDefinition {
  readonly name = "seedance" as const;
  private readonly modelId: string;
  private readonly capabilities: ProviderCapabilities;

  constructor(options: SeedanceProviderDefinitionOptions) {
    if (options.modelId.trim().length === 0) {
      throw new Error("Seedance model ID must not be empty.");
    }
    this.modelId = options.modelId;
    this.capabilities = {
      provider: "seedance",
      label: "Seedance Video",
      testOnly: false,
      supportsCancellation: false,
      acceptedAssetTypes: ["image", "video", "audio"],
      models: [
        {
          id: this.modelId,
          label: "Seedance Video",
          description:
            "真实 Provider 基础能力；仅开放现有协议材料已确认的参数。",
          parameters: [
            {
              key: "ratio",
              label: "视频比例",
              description: "首版仅开放现有 Demo 已出现的值。",
              type: "select",
              required: true,
              defaultValue: "16:9",
              options: [{ label: "16:9", value: "16:9" }],
              group: "primary"
            },
            {
              key: "duration",
              label: "时长参数",
              description: "首版仅开放现有 Demo 已出现的数字值。",
              type: "select",
              required: true,
              defaultValue: 11,
              options: [{ label: "11", value: 11 }],
              group: "primary"
            },
            {
              key: "generateAudio",
              label: "生成音频",
              description: "首版显式发送现有 Demo 已出现的值。",
              type: "boolean",
              required: true,
              defaultValue: true,
              group: "advanced"
            },
            {
              key: "watermark",
              label: "水印",
              description: "首版显式发送现有 Demo 已出现的值。",
              type: "boolean",
              required: true,
              defaultValue: false,
              group: "advanced"
            }
          ]
        }
      ]
    };
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return this.capabilities;
  }

  validateParameters(
    model: string,
    parameters: unknown
  ): ValidationResult<SeedanceParameters> {
    if (model !== this.modelId) {
      return {
        ok: false,
        issues: [
          {
            path: "model",
            code: "UNKNOWN_MODEL",
            message: "Unknown Seedance Provider model."
          }
        ]
      };
    }
    const parsed = seedanceParametersSchema.safeParse(parameters);
    if (!parsed.success) {
      return {
        ok: false,
        issues: parsed.error.issues.map((issue) => ({
          path:
            issue.path.length === 0
              ? "parameters"
              : `parameters.${issue.path.join(".")}`,
          code: "UNSUPPORTED_VALUE",
          message:
            "Parameter is missing or is not an explicitly supported value."
        }))
      };
    }
    return { ok: true, value: parsed.data };
  }
}

export interface SeedanceProviderAdapterOptions extends SeedanceProviderDefinitionOptions {
  bridgeClient: SeedanceBridgeTransport;
}

export interface SeedanceBridgeTransport {
  createTask(input: BridgeCreateVideoTaskRequest): Promise<{ id: string }>;
  recoverTask(clientRequestId: string): Promise<string | null>;
  getTask(providerTaskId: string): Promise<BridgeQueryVideoTaskResponse>;
  downloadOutput(providerTaskId: string): Promise<ProviderDownload>;
}

export class SeedanceProviderAdapter
  extends SeedanceProviderDefinition
  implements ProviderRuntime
{
  private readonly bridgeClient: SeedanceBridgeTransport;

  constructor(options: SeedanceProviderAdapterOptions) {
    super(options);
    this.bridgeClient = options.bridgeClient;
  }

  async createTask(input: CreateTaskInput): Promise<ProviderTaskSnapshot> {
    const validation = this.validateParameters(input.model, input.parameters);
    if (!validation.ok) {
      throw new ProviderValidationError();
    }
    if (
      input.referenceAssetIds.length > 0 &&
      (input.publishedAssets?.length ?? 0) !== input.referenceAssetIds.length
    ) {
      throw new ProviderValidationError(
        "Every referenced asset must have a published Provider URL."
      );
    }
    const request: BridgeCreateVideoTaskRequest = {
      clientRequestId: input.clientRequestId,
      model: input.model,
      request: {
        content: [
          { type: "text", text: input.prompt },
          ...(input.publishedAssets ?? [])
            .slice()
            .sort((left, right) => left.position - right.position)
            .map(toBridgeContent)
        ],
        generate_audio: validation.value.generateAudio,
        ratio: validation.value.ratio,
        duration: validation.value.duration,
        watermark: validation.value.watermark
      }
    };
    const created = await this.bridgeClient.createTask(request);
    return {
      providerTaskId: created.id,
      status: "PROCESSING",
      outputs: [],
      usage: []
    };
  }

  recoverTask(clientRequestId: string): Promise<string | null> {
    return this.bridgeClient.recoverTask(clientRequestId);
  }

  async getTask(providerTaskId: string): Promise<ProviderTaskSnapshot> {
    const response = await this.bridgeClient.getTask(providerTaskId);
    const status = this.normalizeStatus(response.status);
    if (status === "SUCCEEDED" && response.content?.video_url === undefined) {
      throw new ProviderProtocolError(
        "GET",
        "Succeeded Provider task has no video output."
      );
    }
    return {
      providerTaskId,
      status,
      outputs:
        status === "SUCCEEDED" ? [{ kind: "video", available: true }] : [],
      usage: this.normalizeUsage(response),
      ...(status === "FAILED"
        ? {
            error: {
              code: "PROVIDER_TASK_FAILED",
              message: "Seedance Provider task failed.",
              retryable: false
            }
          }
        : {}),
      debug: { providerStatus: response.status }
    };
  }

  async cancelTask(providerTaskId: string): Promise<ProviderTaskSnapshot> {
    void providerTaskId;
    throw new ProviderUnsupportedOperationError("CANCEL");
  }

  normalizeStatus(rawStatus: unknown): ProviderTaskStatus {
    switch (rawStatus) {
      case "pending":
      case "queued":
      case "running":
        return "PROCESSING";
      case "succeeded":
        return "SUCCEEDED";
      case "failed":
        return "FAILED";
      default:
        throw new ProviderProtocolError(
          "NORMALIZE",
          "Seedance Provider returned an unknown status."
        );
    }
  }

  normalizeUsage(rawResponse: unknown): readonly ProviderUsage[] {
    void rawResponse;
    return [];
  }

  downloadOutput(
    providerTaskId: string,
    output: { kind: "video" }
  ): Promise<ProviderDownload> {
    void output;
    return this.bridgeClient.downloadOutput(providerTaskId);
  }
}

function toBridgeContent(asset: PublishedProviderAsset): BridgeVideoContent {
  switch (asset.role) {
    case "REFERENCE_IMAGE":
      return {
        type: "image_url",
        image_url: { url: asset.url },
        role: "reference_image"
      };
    case "REFERENCE_VIDEO":
      return {
        type: "video_url",
        video_url: { url: asset.url },
        role: "reference_video"
      };
    case "REFERENCE_AUDIO":
      return {
        type: "audio_url",
        audio_url: { url: asset.url },
        role: "reference_audio"
      };
  }
}
