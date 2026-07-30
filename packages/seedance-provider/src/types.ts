export type ProviderTaskStatus =
  "PROCESSING" | "SUCCEEDED" | "FAILED" | "CANCELLED";

export type MockScenario = "success" | "failure" | "slow";

export type ParameterDefinition =
  | {
      key: string;
      label: string;
      description: string;
      type: "select";
      required: boolean;
      defaultValue: string;
      options: readonly { label: string; value: string }[];
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
  provider: "mock";
  label: string;
  testOnly: true;
  supportsCancellation: true;
  acceptedAssetTypes: readonly ["image"];
  models: readonly ProviderModel[];
}

export interface MockParameters {
  ratio: "16:9" | "9:16" | "1:1";
  resolution: "720p" | "1080p";
  duration: "5" | "10";
  scenario: MockScenario;
  includeUsage: boolean;
}

export interface CreateTaskInput {
  clientRequestId: string;
  model: string;
  prompt: string;
  referenceAssetIds: readonly string[];
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
  uri: string;
  mimeType: "video/mp4";
}

export interface ProviderTaskSnapshot {
  providerTaskId: string;
  status: ProviderTaskStatus;
  outputs: readonly ProviderOutput[];
  usage: readonly ProviderUsage[];
  error?: ProviderError;
}

export type ValidationResult =
  | { ok: true; value: MockParameters }
  | {
      ok: false;
      issues: readonly { path: string; message: string }[];
    };

export interface SeedanceProvider {
  readonly name: "mock";
  getCapabilities(): Promise<ProviderCapabilities>;
  validateParameters(model: string, parameters: unknown): ValidationResult;
  createTask(input: CreateTaskInput): Promise<ProviderTaskSnapshot>;
  getTask(providerTaskId: string): Promise<ProviderTaskSnapshot>;
  cancelTask(providerTaskId: string): Promise<ProviderTaskSnapshot>;
}
