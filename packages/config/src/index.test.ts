import { describe, expect, it } from "vitest";
import type { ZodError } from "zod";

import {
  hasAssetPublishingConfig,
  hasEosAssetPublishingConfig,
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

  it("normalizes the AICC deployment alias to the Seedance adapter", () => {
    expect(
      loadApiConfig({
        SEEDANCE_PROVIDER: "aicc",
        SEEDANCE_MODEL_ID: "doubao-seedance-2.0"
      }).SEEDANCE_PROVIDER
    ).toBe("seedance");
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

  it("keeps asset publishing optional for text-only seedance tasks", () => {
    const config = loadWorkerConfig({
      SEEDANCE_PROVIDER: "seedance",
      SEEDANCE_MODEL_ID: "fixture-model",
      SEEDANCE_REQUEST_TIMEOUT_MS: "1000",
      SEEDANCE_POLL_INTERVAL_MS: "2000",
      SEEDANCE_MAX_POLL_INTERVAL_MS: "2500",
      SEEDANCE_MAX_POLL_DURATION_MS: "3000",
      SEEDANCE_DOWNLOAD_TIMEOUT_MS: "4000",
      SEEDANCE_BRIDGE_URL: "http://bridge.internal:8080",
      SEEDANCE_BRIDGE_TOKEN: "fixture-bridge-token"
    });
    expect(hasAssetPublishingConfig(config)).toBe(false);
  });

  it("requires complete asset publishing settings when partially configured", () => {
    expect(() =>
      loadApiConfig({
        SEEDANCE_ASSET_SIGNING_KEY: "x".repeat(32)
      })
    ).toThrowError(
      expect.objectContaining<Partial<ZodError>>({
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: ["SEEDANCE_ASSET_PUBLIC_BASE_URL"]
          }),
          expect.objectContaining({ path: ["SEEDANCE_ASSET_URL_TTL_MS"] })
        ])
      })
    );
  });

  it("parses complete server-only asset publishing settings", () => {
    const config = loadApiConfig({
      SEEDANCE_ASSET_SIGNING_KEY: "x".repeat(32),
      SEEDANCE_ASSET_PUBLIC_BASE_URL: "https://assets.example.com",
      SEEDANCE_ASSET_URL_TTL_MS: "300000"
    });
    expect(hasAssetPublishingConfig(config)).toBe(true);
    expect(config.SEEDANCE_ASSET_URL_TTL_MS).toBe(300000);
  });

  it("requires and parses configurable EOS settings for the real Worker", () => {
    const base = {
      SEEDANCE_PROVIDER: "seedance",
      SEEDANCE_MODEL_ID: "fixture-model",
      SEEDANCE_REQUEST_TIMEOUT_MS: "1000",
      SEEDANCE_POLL_INTERVAL_MS: "2000",
      SEEDANCE_MAX_POLL_INTERVAL_MS: "2500",
      SEEDANCE_MAX_POLL_DURATION_MS: "3000",
      SEEDANCE_DOWNLOAD_TIMEOUT_MS: "4000",
      SEEDANCE_BRIDGE_URL: "http://bridge.internal:8080",
      SEEDANCE_BRIDGE_TOKEN: "fixture-bridge-token",
      ASSET_PUBLISHER: "eos"
    };
    expect(() => loadWorkerConfig(base)).toThrowError(
      expect.objectContaining<Partial<ZodError>>({
        issues: expect.arrayContaining([
          expect.objectContaining({ path: ["EOS_ENDPOINT"] }),
          expect.objectContaining({ path: ["EOS_REGION"] }),
          expect.objectContaining({ path: ["EOS_BUCKET"] }),
          expect.objectContaining({ path: ["EOS_ACCESS_KEY_ID"] }),
          expect.objectContaining({ path: ["EOS_SECRET_ACCESS_KEY"] })
        ])
      })
    );
    const config = loadWorkerConfig({
      ...base,
      EOS_ENDPOINT: "https://objects.example.com",
      EOS_REGION: "tenant-region",
      EOS_BUCKET: "private-bucket",
      EOS_ACCESS_KEY_ID: "fixture-access",
      EOS_SECRET_ACCESS_KEY: "fixture-secret",
      EOS_FORCE_PATH_STYLE: "true"
    });
    expect(hasEosAssetPublishingConfig(config)).toBe(true);
    expect(config.EOS_FORCE_PATH_STYLE).toBe(true);
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
