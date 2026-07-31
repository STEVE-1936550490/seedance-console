import type { SeedanceBridgeClient } from "./bridge-client.js";
import {
  MockProviderDefinition,
  MockSeedanceProvider
} from "./mock-provider.js";
import {
  SeedanceProviderAdapter,
  SeedanceProviderDefinition
} from "./seedance-provider.js";
import type {
  ProviderDefinition,
  ProviderName,
  ProviderRuntime
} from "./types.js";

export type ProviderDefinitionFactoryOptions =
  { provider: "mock" } | { provider: "seedance"; modelId: string };

export type ProviderRuntimeFactoryOptions =
  | { provider: "mock" }
  | {
      provider: "seedance";
      modelId: string;
      bridgeClient: SeedanceBridgeClient;
    };

export function createProviderDefinition(
  options: ProviderDefinitionFactoryOptions
): ProviderDefinition {
  return options.provider === "mock"
    ? new MockProviderDefinition()
    : new SeedanceProviderDefinition({ modelId: options.modelId });
}

export function createProviderRuntime(
  options: ProviderRuntimeFactoryOptions
): ProviderRuntime {
  return options.provider === "mock"
    ? new MockSeedanceProvider()
    : new SeedanceProviderAdapter({
        modelId: options.modelId,
        bridgeClient: options.bridgeClient
      });
}

export function assertProviderName(value: string): ProviderName {
  if (value === "mock" || value === "seedance") return value;
  throw new Error("SEEDANCE_PROVIDER must be mock or seedance.");
}
