import { describe, expect, it } from "vitest";
import type { ZodError } from "zod";

import {
  loadApiConfig,
  loadSeedanceBridgeConfig,
  loadWorkerConfig
} from "./index.js";

describe("Provider configuration", () => {
  it("keeps mock as the default without requiring real Provider settings", () => {
    expect(loadApiConfig({}).SEEDANCE_PROVIDER).toBe("mock");
    const worker = loadWorkerConfig({});
    expect(worker.SEEDANCE_PROVIDER).toBe("mock");
    expect(worker.REAL_API_TEST).toBe(false);
  });

  it("requires non-secret definition settings in API seedance mode", () => {
    expect(() => loadApiConfig({ SEEDANCE_PROVIDER: "seedance" })).toThrowError(
      expect.objectContaining<Partial<ZodError>>({
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: ["SEEDANCE_MODEL_ID"],
            message:
              "SEEDANCE_MODEL_ID is required when SEEDANCE_PROVIDER=seedance."
          })
        ])
      })
    );
  });

  it("requires Worker runtime settings in seedance mode", () => {
    expect(() =>
      loadWorkerConfig({
        SEEDANCE_PROVIDER: "seedance",
        SEEDANCE_MODEL_ID: "fixture-model"
      })
    ).toThrowError(
      expect.objectContaining<Partial<ZodError>>({
        issues: expect.arrayContaining([
          expect.objectContaining({ path: ["SEEDANCE_BRIDGE_URL"] }),
          expect.objectContaining({ path: ["SEEDANCE_BRIDGE_TOKEN"] }),
          expect.objectContaining({ path: ["SEEDANCE_REQUEST_TIMEOUT_MS"] }),
          expect.objectContaining({ path: ["SEEDANCE_POLL_INTERVAL_MS"] }),
          expect.objectContaining({
            path: ["SEEDANCE_MAX_POLL_INTERVAL_MS"]
          }),
          expect.objectContaining({
            path: ["SEEDANCE_MAX_POLL_DURATION_MS"]
          }),
          expect.objectContaining({ path: ["SEEDANCE_DOWNLOAD_TIMEOUT_MS"] })
        ])
      })
    );
  });

  it("parses a complete seedance Worker configuration", () => {
    const config = loadWorkerConfig({
      SEEDANCE_PROVIDER: "seedance",
      SEEDANCE_MODEL_ID: "fixture-model",
      SEEDANCE_REQUEST_TIMEOUT_MS: "1000",
      SEEDANCE_POLL_INTERVAL_MS: "2000",
      SEEDANCE_MAX_POLL_INTERVAL_MS: "2500",
      SEEDANCE_MAX_POLL_DURATION_MS: "3000",
      SEEDANCE_DOWNLOAD_TIMEOUT_MS: "4000",
      SEEDANCE_BRIDGE_URL: "http://bridge.internal:8080",
      SEEDANCE_BRIDGE_TOKEN: "fixture-bridge-token",
      REAL_API_TEST: "false"
    });
    expect(config).toMatchObject({
      SEEDANCE_PROVIDER: "seedance",
      SEEDANCE_REQUEST_TIMEOUT_MS: 1000,
      SEEDANCE_POLL_INTERVAL_MS: 2000,
      SEEDANCE_MAX_POLL_INTERVAL_MS: 2500,
      SEEDANCE_MAX_POLL_DURATION_MS: 3000,
      SEEDANCE_DOWNLOAD_TIMEOUT_MS: 4000,
      REAL_API_TEST: false
    });
  });

  it("keeps API Key and Base URL in the Bridge-only config", () => {
    const config = loadSeedanceBridgeConfig({
      SEEDANCE_BASE_URL: "https://provider.invalid/api",
      SEEDANCE_API_KEY: "fixture-api-key",
      SEEDANCE_MODEL_ID: "fixture-model",
      SEEDANCE_REQUEST_TIMEOUT_MS: "1000",
      SEEDANCE_DOWNLOAD_TIMEOUT_MS: "2000",
      SEEDANCE_BRIDGE_TOKEN: "fixture-bridge-token"
    });
    expect(config.SEEDANCE_API_KEY).toBe("fixture-api-key");
    expect("SEEDANCE_API_KEY" in loadApiConfig({})).toBe(false);
  });

  it("fails Bridge startup clearly when real credentials are missing", () => {
    expect(() => loadSeedanceBridgeConfig({})).toThrowError(
      expect.objectContaining<Partial<ZodError>>({
        issues: expect.arrayContaining([
          expect.objectContaining({ path: ["SEEDANCE_BASE_URL"] }),
          expect.objectContaining({ path: ["SEEDANCE_API_KEY"] }),
          expect.objectContaining({ path: ["SEEDANCE_MODEL_ID"] }),
          expect.objectContaining({ path: ["SEEDANCE_BRIDGE_TOKEN"] })
        ])
      })
    );
  });
});
