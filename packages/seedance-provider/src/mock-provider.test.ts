import { describe, expect, it } from "vitest";

import { MockSeedanceProvider } from "./mock-provider.js";
import type { MockProviderError } from "./mock-provider.js";

describe("MockSeedanceProvider", () => {
  it("creates idempotently and reaches success after deterministic polling", async () => {
    const provider = new MockSeedanceProvider();
    const input = {
      clientRequestId: "request-1",
      model: "mock-video-v1",
      prompt: "A test-only prompt",
      referenceAssetIds: [],
      parameters: {
        ratio: "16:9",
        resolution: "720p",
        duration: "5",
        scenario: "success",
        includeUsage: true
      }
    };

    const created = await provider.createTask(input);
    const duplicate = await provider.createTask(input);
    expect(duplicate.providerTaskId).toBe(created.providerTaskId);
    expect((await provider.getTask(created.providerTaskId)).status).toBe(
      "PROCESSING"
    );

    const completed = await provider.getTask(created.providerTaskId);
    expect(completed.status).toBe("SUCCEEDED");
    expect(completed.usage).toHaveLength(1);
  });

  it("supports failure, slow, and cancellation scenarios", async () => {
    const provider = new MockSeedanceProvider();
    const failed = await provider.createTask({
      clientRequestId: "request-failure",
      model: "mock-video-v1",
      prompt: "Failure",
      referenceAssetIds: [],
      parameters: { scenario: "failure" }
    });
    await provider.getTask(failed.providerTaskId);
    expect((await provider.getTask(failed.providerTaskId)).status).toBe(
      "FAILED"
    );

    const slow = await provider.createTask({
      clientRequestId: "request-slow",
      model: "mock-video-v1",
      prompt: "Slow",
      referenceAssetIds: [],
      parameters: { scenario: "slow" }
    });
    expect((await provider.getTask(slow.providerTaskId)).status).toBe(
      "PROCESSING"
    );
    expect((await provider.cancelTask(slow.providerTaskId)).status).toBe(
      "CANCELLED"
    );
  });

  it("rejects unknown parameters and missing tasks", async () => {
    const provider = new MockSeedanceProvider();
    await expect(
      provider.createTask({
        clientRequestId: "request-invalid",
        model: "mock-video-v1",
        prompt: "Invalid",
        referenceAssetIds: [],
        parameters: { duration: 11 }
      })
    ).rejects.toMatchObject<Partial<MockProviderError>>({
      code: "INVALID_PARAMETERS"
    });
    await expect(provider.getTask("missing")).rejects.toMatchObject<
      Partial<MockProviderError>
    >({ code: "TASK_NOT_FOUND" });
  });
});
