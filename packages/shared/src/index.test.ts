import { describe, expect, it } from "vitest";

import { parseVideoGenerationJob, providerJobId } from "./index.js";

describe("Provider queue payloads", () => {
  it("validates independent submit, poll, and download payloads", () => {
    expect(
      parseVideoGenerationJob({
        kind: "provider-submit",
        taskId: "task-1"
      })
    ).toEqual({ kind: "provider-submit", taskId: "task-1" });
    const poll = parseVideoGenerationJob({
      kind: "provider-poll",
      taskId: "task-1",
      pollVersion: 3
    });
    expect(poll).toEqual({
      kind: "provider-poll",
      taskId: "task-1",
      pollVersion: 3
    });
    expect(providerJobId(poll)).toBe("provider-poll-task-1-v3");
    expect(
      parseVideoGenerationJob({
        kind: "provider-download",
        taskId: "task-1"
      })
    ).toEqual({ kind: "provider-download", taskId: "task-1" });
  });

  it("rejects malformed and non-versioned poll payloads", () => {
    expect(() =>
      parseVideoGenerationJob({
        kind: "provider-poll",
        taskId: "task-1",
        pollVersion: 0
      })
    ).toThrow("Invalid Provider job payload.");
    expect(() =>
      parseVideoGenerationJob({ kind: "provider-submit", taskId: "" })
    ).toThrow("Invalid Provider job task ID.");
  });
});
