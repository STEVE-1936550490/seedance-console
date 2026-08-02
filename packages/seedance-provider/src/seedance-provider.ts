import { z } from "zod";

import type {
  BridgeCreateVideoTaskRequest,
  BridgeCreateVideoTaskResponse,
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
    generateAudio: z.boolean(),
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
      supportsReferenceImage: true,
      maxReferenceImages: 1,
      supportsReferenceVideo: true,
      maxReferenceVideos: 1,
      acceptedAssetTypes: ["image", "video"],
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
              defaultValue: false,
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
  createTask(
    input: BridgeCreateVideoTaskRequest
  ): Promise<BridgeCreateVideoTaskResponse>;
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
    const publishedAssets = input.publishedAssets ?? [];
    if (publishedAssets.length !== input.referenceAssetIds.length) {
      throw new ProviderValidationError(
        "Every referenced asset must have a published Provider URL."
      );
    }
    if (input.referenceAssetIds.length > 1) {
      throw new ProviderValidationError(
        "Seedance MVP supports exactly one reference asset at most."
      );
    }
    for (const [position, asset] of publishedAssets.entries()) {
      if (
        asset.assetId !== input.referenceAssetIds[position] ||
        asset.position !== position ||
        !isSupportedPublishedAsset(asset) ||
        !/^[a-f0-9]{64}$/.test(asset.checksum) ||
        asset.sizeBytes <= 0 ||
        asset.expiresAt.getTime() <= Date.now() ||
        !isHttpsUrl(asset.url)
      ) {
        throw new ProviderValidationError(
          "Published reference asset is invalid or expired."
        );
      }
    }
    const textContent = { type: "text" as const, text: input.prompt };
    const content: BridgeCreateVideoTaskRequest["request"]["content"] =
      publishedAssets.length === 0
        ? [textContent]
        : publishedAssets[0]!.role === "REFERENCE_IMAGE"
          ? [textContent, toBridgeImageContent(publishedAssets[0]!)]
          : [textContent, toBridgeVideoContent(publishedAssets[0]!)];
    const request: BridgeCreateVideoTaskRequest = {
      clientRequestId: input.clientRequestId,
      ...(input.createAttemptId === undefined
        ? {}
        : { createAttemptId: input.createAttemptId }),
      ...(input.requestPayloadSha256 === undefined
        ? {}
        : { requestPayloadSha256: input.requestPayloadSha256 }),
      model: input.model,
      request: {
        content,
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
      usage: [],
      ...(created.audit === undefined ? {} : { createAudit: created.audit })
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

function toBridgeImageContent(
  asset: PublishedProviderAsset
): Extract<BridgeVideoContent, { type: "image_url" }> {
  return {
    type: "image_url",
    image_url: { url: asset.url },
    role: "reference_image"
  };
}

function toBridgeVideoContent(
  asset: PublishedProviderAsset
): Extract<BridgeVideoContent, { type: "video_url" }> {
  return {
    type: "video_url",
    video_url: { url: asset.url },
    role: "reference_video"
  };
}

function isSupportedPublishedAsset(asset: PublishedProviderAsset): boolean {
  if (asset.role === "REFERENCE_IMAGE") {
    return asset.mimeType === "image/png" || asset.mimeType === "image/jpeg";
  }
  return (
    asset.mimeType === "video/mp4" &&
    asset.metadata !== undefined &&
    asset.metadata.container === "mp4" &&
    asset.metadata.durationSeconds >= 2 &&
    asset.metadata.durationSeconds <= 15
  );
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
