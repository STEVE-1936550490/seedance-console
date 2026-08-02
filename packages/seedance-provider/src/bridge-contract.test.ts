import { describe, expect, it } from "vitest";

import { bridgeCreateVideoTaskResponseSchema } from "./bridge-contract.js";

describe("Bridge ISO 8601 audit timestamps", () => {
  it.each([
    [
      "UTC Z with milliseconds",
      "2026-08-02T14:50:34.783Z",
      "2026-08-02T14:50:34.783Z"
    ],
    [
      "UTC Z without milliseconds",
      "2026-08-02T14:50:34Z",
      "2026-08-02T14:50:34.000Z"
    ],
    [
      "explicit +08:00 with milliseconds",
      "2026-08-02T22:50:34.783+08:00",
      "2026-08-02T14:50:34.783Z"
    ],
    [
      "explicit +08:00 without milliseconds",
      "2026-08-02T22:50:34+08:00",
      "2026-08-02T14:50:34.000Z"
    ]
  ])("normalizes %s", (_label, input, expected) => {
    expect(parseAuditTime(input)).toBe(expected);
  });

  it.each([
    "2026-08-02 14:50:34",
    "2026-08-02T14:50:34",
    "2026-08-02",
    "not-a-date",
    "2026-13-40T25:61:61Z"
  ])("rejects an ambiguous or invalid timestamp: %s", (input) => {
    expect(
      bridgeCreateVideoTaskResponseSchema.safeParse(responseWithTime(input))
        .success
    ).toBe(false);
  });

  it("preserves the instant across a daylight-saving offset", () => {
    expect(parseAuditTime("2026-11-01T01:30:00-04:00")).toBe(
      "2026-11-01T05:30:00.000Z"
    );
  });

  it("preserves the instant across an +08:00 calendar-day boundary", () => {
    expect(parseAuditTime("2026-08-03T00:30:00+08:00")).toBe(
      "2026-08-02T16:30:00.000Z"
    );
  });

  it("round-trips Bridge JSON through Worker Date and database UTC serialization", () => {
    const bridgeJson = JSON.parse(
      JSON.stringify(responseWithTime("2026-08-02T22:50:34.783+08:00"))
    ) as unknown;
    const parsed = bridgeCreateVideoTaskResponseSchema.parse(bridgeJson);
    const databaseValue = new Date(parsed.audit!.requestStartedAt!);
    const workerReadBack = new Date(databaseValue.getTime()).toISOString();

    expect(workerReadBack).toBe("2026-08-02T14:50:34.783Z");
  });
});

function parseAuditTime(value: string): string {
  return bridgeCreateVideoTaskResponseSchema.parse(responseWithTime(value))
    .audit!.requestStartedAt!;
}

function responseWithTime(value: string) {
  return {
    id: "provider-task-1",
    audit: {
      bridgeRequestId: "bridge-request-1",
      requestStartedAt: value
    }
  };
}
