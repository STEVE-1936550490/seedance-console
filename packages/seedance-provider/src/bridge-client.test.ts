import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";

import { SeedanceBridgeClient } from "./bridge-client.js";
import {
  ProviderAuthenticationError,
  ProviderOutcomeUnknownError,
  ProviderProtocolError,
  ProviderRateLimitError,
  ProviderTransientError,
  ProviderUnsupportedOperationError
} from "./errors.js";

const fixtureNames = [
  "create-success",
  "pending",
  "queued",
  "running",
  "succeeded",
  "failed",
  "unknown-status",
  "missing-status",
  "error-401",
  "error-429",
  "error-503"
] as const;

describe("SeedanceBridgeClient", () => {
  let client: SeedanceBridgeClient;
  let lastAuthorization: string | null;
  let lastCreateBody: unknown;
  let createRequests = 0;
  const fixtures = new Map<string, unknown>();

  beforeAll(async () => {
    await Promise.all(
      fixtureNames.map(async (name) => {
        fixtures.set(name, JSON.parse(await readFixture(name)) as unknown);
      })
    );

    client = new SeedanceBridgeClient({
      baseUrl: "http://bridge.fixture.invalid",
      token: "fixture-internal-token",
      requestTimeoutMs: 25,
      downloadTimeoutMs: 25,
      fetchImplementation: createFixtureFetch()
    });
  });

  it("checks health and detects that cancellation is disabled", async () => {
    await expect(client.supportsCancellation()).resolves.toBe(false);
    expect(lastAuthorization).toBe("Bearer fixture-internal-token");
  });

  it("creates once and validates the returned id", async () => {
    const before = createRequests;
    await expect(
      client.createTask(fixtureCreateRequest("create-success"))
    ).resolves.toEqual({ id: "fixture-provider-task-1" });
    expect(createRequests - before).toBe(1);
    expect(lastCreateBody).toMatchObject({
      clientRequestId: "create-success",
      request: { ratio: "16:9", duration: 11 }
    });
  });

  it("recovers a registered submission without creating again", async () => {
    const before = createRequests;
    await expect(client.recoverTask("registered")).resolves.toBe(
      "fixture-provider-task-1"
    );
    await expect(client.recoverTask("missing")).resolves.toBeNull();
    expect(createRequests).toBe(before);
  });

  it.each(["pending", "queued", "running", "succeeded", "failed"])(
    "accepts the confirmed %s response fixture",
    async (status) => {
      await expect(client.getTask(status)).resolves.toMatchObject({ status });
    }
  );

  it("returns an unknown raw status for the Adapter to reject", async () => {
    await expect(client.getTask("unknown-status")).resolves.toEqual({
      status: "future_provider_status"
    });
  });

  it("rejects responses with missing required fields", async () => {
    await expect(client.getTask("missing-status")).rejects.toBeInstanceOf(
      ProviderProtocolError
    );
  });

  it("classifies 401, 429, 5xx and query timeout without retrying", async () => {
    await expect(client.getTask("auth")).rejects.toBeInstanceOf(
      ProviderAuthenticationError
    );
    const rateLimitError = await client
      .getTask("rate")
      .catch((error: unknown) => error);
    expect(rateLimitError).toBeInstanceOf(ProviderRateLimitError);
    expect(rateLimitError).toMatchObject({
      retry: "SAFE_READ",
      retryAfterMs: 2_000
    });
    await expect(client.getTask("server-error")).rejects.toBeInstanceOf(
      ProviderTransientError
    );
    await expect(client.getTask("timeout")).rejects.toBeInstanceOf(
      ProviderTransientError
    );
  });

  it("does not retry create when a 5xx makes its outcome unknown", async () => {
    const before = createRequests;
    await expect(
      client.createTask(fixtureCreateRequest("create-server-error"))
    ).rejects.toBeInstanceOf(ProviderOutcomeUnknownError);
    expect(createRequests - before).toBe(1);
  });

  it("reports cancellation as unsupported", async () => {
    await expect(client.cancelTask("running")).rejects.toBeInstanceOf(
      ProviderUnsupportedOperationError
    );
  });

  it("streams output bytes through the private Bridge endpoint", async () => {
    const output = await client.downloadOutput("succeeded");
    const chunks: Buffer[] = [];
    for await (const chunk of output.body) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    expect(Buffer.concat(chunks).toString()).toBe("fixture-mp4");
    expect(output).toMatchObject({
      contentType: "video/mp4",
      contentLength: 11
    });
  });

  function createFixtureFetch(): typeof fetch {
    return async (input, init) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL
          ? input.toString()
          : input.url
      );
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      lastAuthorization = headers.get("authorization");

      if (method === "GET" && url.pathname === "/health") {
        return jsonResponse(200, {
          status: "ok",
          capabilities: { cancellation: false }
        });
      }

      if (method === "POST" && url.pathname === "/v1/video/tasks") {
        createRequests += 1;
        lastCreateBody = JSON.parse(String(init?.body)) as unknown;
        const requestId = getClientRequestId(lastCreateBody);
        return requestId === "create-server-error"
          ? bridgeErrorResponse(500, "CREATE", "SAFE_READ")
          : jsonResponse(200, fixtures.get("create-success"));
      }

      const submissionMatch = url.pathname.match(
        /^\/v1\/video\/submissions\/([^/]+)$/
      );
      if (method === "GET" && submissionMatch !== null) {
        return jsonResponse(200, {
          id:
            decodeURIComponent(submissionMatch[1] ?? "") === "registered"
              ? "fixture-provider-task-1"
              : null
        });
      }

      const match = url.pathname.match(
        /^\/v1\/video\/tasks\/([^/]+)(\/output)?$/
      );
      if (match === null) {
        return bridgeErrorResponse(404, "GET", "NEVER");
      }
      const taskId = decodeURIComponent(match[1] ?? "");
      if (match[2] === "/output") {
        return new Response(Buffer.from("fixture-mp4"), {
          status: 200,
          headers: {
            "Content-Type": "video/mp4",
            "Content-Length": "11"
          }
        });
      }
      if (method === "DELETE") {
        return bridgeErrorResponse(
          501,
          "CANCEL",
          "NEVER",
          "OPERATION_UNSUPPORTED"
        );
      }
      if (taskId === "timeout") {
        return waitForAbort(init?.signal);
      }
      if (taskId === "auth") {
        return jsonResponse(401, fixtures.get("error-401"));
      }
      if (taskId === "rate") {
        const response = jsonResponse(429, fixtures.get("error-429"));
        response.headers.set("Retry-After", "2");
        return response;
      }
      if (taskId === "server-error") {
        return jsonResponse(503, fixtures.get("error-503"));
      }
      const fixture = fixtures.get(taskId);
      return fixture === undefined
        ? bridgeErrorResponse(404, "GET", "NEVER")
        : jsonResponse(200, fixture);
    };
  }
});

function fixtureCreateRequest(clientRequestId: string) {
  return {
    clientRequestId,
    model: "fixture-model",
    request: {
      content: [{ type: "text" as const, text: "fixture prompt" }],
      generate_audio: true as const,
      ratio: "16:9" as const,
      duration: 11 as const,
      watermark: false as const
    }
  };
}

async function readFixture(name: string): Promise<string> {
  return readFile(
    new URL(`../fixtures/bridge/${name}.json`, import.meta.url),
    "utf8"
  );
}

function getClientRequestId(body: unknown): string | undefined {
  return typeof body === "object" &&
    body !== null &&
    "clientRequestId" in body &&
    typeof body.clientRequestId === "string"
    ? body.clientRequestId
    : undefined;
}

function jsonResponse(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

function bridgeErrorResponse(
  status: number,
  operation: "CREATE" | "GET" | "CANCEL",
  retry: "NEVER" | "SAFE_READ",
  code = "FIXTURE_ERROR"
): Response {
  return jsonResponse(status, {
    error: {
      code,
      message: "Fixture Bridge error.",
      operation,
      retry,
      requestId: "fixture-request-id"
    }
  });
}

function waitForAbort(
  signal: AbortSignal | null | undefined
): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const abort = () =>
      reject(new DOMException("Fixture request timed out.", "AbortError"));
    if (signal?.aborted === true) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}
