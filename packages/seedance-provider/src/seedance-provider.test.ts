import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  ProviderProtocolError,
  ProviderUnsupportedOperationError,
  ProviderValidationError
} from "./errors.js";
import {
  SeedanceProviderAdapter,
  SeedanceProviderDefinition,
  type SeedanceBridgeTransport
} from "./seedance-provider.js";

describe("SeedanceProviderDefinition", () => {
  it("exposes only confirmed parameters and keeps cancellation disabled", async () => {
    const definition = new SeedanceProviderDefinition({
      modelId: "fixture-model"
    });
    await expect(definition.getCapabilities()).resolves.toMatchObject({
      provider: "seedance",
      testOnly: false,
      supportsCancellation: false,
      models: [
        {
          id: "fixture-model",
          parameters: [
            { key: "ratio", defaultValue: "16:9" },
            { key: "duration", defaultValue: 11 },
            { key: "generateAudio", defaultValue: true },
            { key: "watermark", defaultValue: false }
          ]
        }
      ]
    });
  });

  it("accepts only the explicitly confirmed first-version values", () => {
    const definition = new SeedanceProviderDefinition({
      modelId: "fixture-model"
    });
    expect(
      definition.validateParameters("fixture-model", validParameters())
    ).toEqual({ ok: true, value: validParameters() });
    expect(
      definition.validateParameters("fixture-model", {
        ...validParameters(),
        duration: 12
      })
    ).toMatchObject({ ok: false });
    expect(
      definition.validateParameters("fixture-model", {
        ...validParameters(),
        resolution: "1080p"
      })
    ).toMatchObject({ ok: false });
  });
});

describe("SeedanceProviderAdapter skeleton", () => {
  it("maps a create request and does not retry it", async () => {
    const transport = createTransport();
    const adapter = createAdapter(transport);
    const result = await adapter.createTask({
      clientRequestId: "fixture-request-id",
      model: "fixture-model",
      prompt: "fixture prompt",
      referenceAssetIds: ["asset-1"],
      publishedAssets: [
        {
          assetId: "asset-1",
          role: "REFERENCE_IMAGE",
          position: 0,
          mimeType: "image/jpeg",
          sizeBytes: 100,
          url: "https://assets.invalid/fixture.jpg?token=redacted"
        }
      ],
      parameters: validParameters()
    });
    expect(transport.createTask).toHaveBeenCalledTimes(1);
    expect(transport.createTask).toHaveBeenCalledWith({
      clientRequestId: "fixture-request-id",
      model: "fixture-model",
      request: {
        content: [
          { type: "text", text: "fixture prompt" },
          {
            type: "image_url",
            image_url: {
              url: "https://assets.invalid/fixture.jpg?token=redacted"
            },
            role: "reference_image"
          }
        ],
        generate_audio: true,
        ratio: "16:9",
        duration: 11,
        watermark: false
      }
    });
    expect(result).toEqual({
      providerTaskId: "fixture-provider-task-1",
      status: "PROCESSING",
      outputs: [],
      usage: []
    });
  });

  it("requires published URLs for every referenced asset", async () => {
    const adapter = createAdapter(createTransport());
    await expect(
      adapter.createTask({
        clientRequestId: "fixture-request-id",
        model: "fixture-model",
        prompt: "fixture prompt",
        referenceAssetIds: ["asset-1"],
        parameters: validParameters()
      })
    ).rejects.toBeInstanceOf(ProviderValidationError);
  });

  it.each([
    ["pending", "PROCESSING"],
    ["queued", "PROCESSING"],
    ["running", "PROCESSING"],
    ["succeeded", "SUCCEEDED"],
    ["failed", "FAILED"]
  ] as const)("maps %s to %s", (rawStatus, expected) => {
    const adapter = createAdapter(createTransport());
    expect(adapter.normalizeStatus(rawStatus)).toBe(expected);
  });

  it("does not guess an unknown Provider status", () => {
    const adapter = createAdapter(createTransport());
    expect(() => adapter.normalizeStatus("future_status")).toThrow(
      ProviderProtocolError
    );
  });

  it("keeps remote success separate from local persistence", async () => {
    const transport = createTransport({
      getTask: vi.fn(async () => ({
        status: "succeeded",
        content: {
          video_url: "https://media.invalid/fixture.mp4?signature=redacted"
        }
      }))
    });
    const snapshot = await createAdapter(transport).getTask(
      "fixture-provider-task-1"
    );
    expect(snapshot).toMatchObject({
      status: "SUCCEEDED",
      outputs: [{ kind: "video", available: true }],
      usage: []
    });
    expect(JSON.stringify(snapshot)).not.toContain("signature=redacted");
  });

  it("returns no invented usage and keeps cancellation disabled", async () => {
    const adapter = createAdapter(createTransport());
    expect(adapter.normalizeUsage({ usage: 999 })).toEqual([]);
    await expect(
      adapter.cancelTask("fixture-provider-task-1")
    ).rejects.toBeInstanceOf(ProviderUnsupportedOperationError);
  });

  it("delegates output streaming without exposing the signed URL", async () => {
    const transport = createTransport();
    const output = await createAdapter(transport).downloadOutput(
      "fixture-provider-task-1",
      { kind: "video" }
    );
    expect(transport.downloadOutput).toHaveBeenCalledWith(
      "fixture-provider-task-1"
    );
    expect(output.contentType).toBe("video/mp4");
  });
});

function validParameters() {
  return {
    ratio: "16:9" as const,
    duration: 11 as const,
    generateAudio: true as const,
    watermark: false as const
  };
}

function createAdapter(transport: SeedanceBridgeTransport) {
  return new SeedanceProviderAdapter({
    modelId: "fixture-model",
    bridgeClient: transport
  });
}

function createTransport(
  overrides: Partial<SeedanceBridgeTransport> = {}
): SeedanceBridgeTransport & {
  createTask: ReturnType<typeof vi.fn>;
  recoverTask: ReturnType<typeof vi.fn>;
  getTask: ReturnType<typeof vi.fn>;
  downloadOutput: ReturnType<typeof vi.fn>;
} {
  return {
    createTask: vi.fn(async () => ({ id: "fixture-provider-task-1" })),
    recoverTask: vi.fn(async () => null),
    getTask: vi.fn(async () => ({ status: "running" })),
    downloadOutput: vi.fn(async () => ({
      body: Readable.from(Buffer.from("fixture-mp4")),
      contentType: "video/mp4"
    })),
    ...overrides
  };
}
