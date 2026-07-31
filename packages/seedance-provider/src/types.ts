import type { Readable } from "node:stream";

export type ProviderName = "mock" | "seedance";

export type ProviderTaskStatus =
  "PROCESSING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "EXPIRED";

export type ProviderAssetType = "image" | "video" | "audio";

export type ProviderAssetRole =
  "REFERENCE_IMAGE" | "REFERENCE_VIDEO" | "REFERENCE_AUDIO";

export type MockScenario = "success" | "failure" | "slow";

export type ParameterDefinition =
  | {
      key: string;
      label: string;
      description: string;
      type: "select";
      required: boolean;
      defaultValue: string | number;
      options: readonly {
        label: string;
        value: string | number;
      }[];
      group: "primary" | "advanced";
    }
  | {
      key: string;
      label: string;
      description: string;
      type: "boolean";
      required: boolean;
      defaultValue: boolean;
      group: "primary" | "advanced";
    };

export interface ProviderModel {
  id: string;
  label: string;
  description: string;
  parameters: readonly ParameterDefinition[];
}

export interface ProviderCapabilities {
  provider: ProviderName;
  label: string;
  testOnly: boolean;
  supportsCancellation: boolean;
  acceptedAssetTypes: readonly ProviderAssetType[];
  models: readonly ProviderModel[];
}

export type MockParameters = {
  ratio: "16:9" | "9:16" | "1:1";
  resolution: "720p" | "1080p";
  duration: "5" | "10";
  scenario: MockScenario;
  includeUsage: boolean;
};

export type SeedanceParameters = {
  ratio: "16:9";
  duration: 11;
  generateAudio: true;
  watermark: false;
};

export interface PublishedProviderAsset {
  assetId: string;
  role: ProviderAssetRole;
  position: number;
  mimeType: string;
  sizeBytes: number;
  checksum?: string;
  url: string;
  expiresAt?: Date;
}

export interface CreateTaskInput {
  clientRequestId: string;
  model: string;
  prompt: string;
  referenceAssetIds: readonly string[];
  publishedAssets?: readonly PublishedProviderAsset[];
  parameters: unknown;
}

export interface ProviderError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface ProviderUsage {
  metric: string;
  quantity: string;
  unit: string;
}

export interface ProviderOutput {
  kind: "video";
  available: boolean;
  uri?: string;
  mimeType?: string;
}

export interface ProviderTaskSnapshot {
  providerTaskId: string;
  status: ProviderTaskStatus;
  outputs: readonly ProviderOutput[];
  usage: readonly ProviderUsage[];
  error?: ProviderError;
  debug?: {
    providerStatus?: string;
    providerRequestId?: string;
  };
}

export interface ProviderDownload {
  body: Readable;
  contentType?: string;
  contentLength?: number;
  fileName?: string;
}

export type ValidationIssue = {
  path: string;
  code: string;
  message: string;
};

export type ValidationResult<
  T extends object = Readonly<Record<string, unknown>>
> =
  | { ok: true; value: T }
  | {
      ok: false;
      issues: readonly ValidationIssue[];
    };

export interface ProviderDefinition {
  readonly name: ProviderName;
  getCapabilities(): Promise<ProviderCapabilities>;
  validateParameters(model: string, parameters: unknown): ValidationResult;
}

export interface ProviderRuntime extends ProviderDefinition {
  createTask(input: CreateTaskInput): Promise<ProviderTaskSnapshot>;
  recoverTask(clientRequestId: string): Promise<string | null>;
  getTask(providerTaskId: string): Promise<ProviderTaskSnapshot>;
  cancelTask(providerTaskId: string): Promise<ProviderTaskSnapshot>;
  normalizeStatus(rawStatus: unknown): ProviderTaskStatus;
  normalizeUsage(rawResponse: unknown): readonly ProviderUsage[];
  downloadOutput(
    providerTaskId: string,
    output: { kind: "video" }
  ): Promise<ProviderDownload>;
}

/**
 * Backwards-compatible name for the runtime contract used by the current
 * Mock-only worker. New API-side dependencies should use ProviderDefinition.
 */
export type SeedanceProvider = ProviderRuntime;
