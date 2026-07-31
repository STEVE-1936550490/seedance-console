import { Readable } from "node:stream";

import {
  bridgeCreateVideoTaskRequestSchema,
  bridgeCreateVideoTaskResponseSchema,
  bridgeErrorResponseSchema,
  bridgeHealthResponseSchema,
  bridgeQueryVideoTaskResponseSchema,
  bridgeRecoverVideoTaskResponseSchema,
  type BridgeCreateVideoTaskRequest,
  type BridgeCreateVideoTaskResponse,
  type BridgeHealthResponse,
  type BridgeQueryVideoTaskResponse
} from "./bridge-contract.js";
import {
  ProviderAuthenticationError,
  ProviderDownloadValidationError,
  ProviderOutputExpiredError,
  ProviderOutcomeUnknownError,
  ProviderProtocolError,
  ProviderRateLimitError,
  ProviderRequestError,
  ProviderTransientError,
  ProviderUnsupportedOperationError,
  type ProviderOperation,
  type ProviderRetry
} from "./errors.js";
import type { ProviderDownload } from "./types.js";

export interface SeedanceBridgeClientOptions {
  baseUrl: string;
  token: string;
  requestTimeoutMs: number;
  downloadTimeoutMs: number;
  fetchImplementation?: typeof fetch;
}

export class SeedanceBridgeClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly requestTimeoutMs: number;
  private readonly downloadTimeoutMs: number;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: SeedanceBridgeClientOptions) {
    this.baseUrl = parseBaseUrl(options.baseUrl);
    if (options.token.trim().length === 0) {
      throw new Error("Seedance Bridge token must not be empty.");
    }
    if (
      !Number.isSafeInteger(options.requestTimeoutMs) ||
      options.requestTimeoutMs <= 0 ||
      !Number.isSafeInteger(options.downloadTimeoutMs) ||
      options.downloadTimeoutMs <= 0
    ) {
      throw new Error("Seedance Bridge timeouts must be positive integers.");
    }
    this.token = options.token;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.downloadTimeoutMs = options.downloadTimeoutMs;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async healthCheck(): Promise<BridgeHealthResponse> {
    const response = await this.request("/health", {
      method: "GET",
      operation: "HEALTH",
      timeoutMs: this.requestTimeoutMs,
      retry: "SAFE_READ"
    });
    return parseJsonResponse(response, bridgeHealthResponseSchema, "HEALTH");
  }

  async supportsCancellation(): Promise<boolean> {
    return (await this.healthCheck()).capabilities.cancellation;
  }

  async createTask(
    input: BridgeCreateVideoTaskRequest
  ): Promise<BridgeCreateVideoTaskResponse> {
    const request = bridgeCreateVideoTaskRequestSchema.safeParse(input);
    if (!request.success) {
      throw new ProviderProtocolError(
        "CREATE",
        "Bridge create request does not match the contract."
      );
    }
    const response = await this.request("/v1/video/tasks", {
      method: "POST",
      operation: "CREATE",
      timeoutMs: this.requestTimeoutMs,
      retry: "MANUAL_RECONCILIATION",
      body: JSON.stringify(request.data)
    });
    return parseJsonResponse(
      response,
      bridgeCreateVideoTaskResponseSchema,
      "CREATE"
    );
  }

  async getTask(providerTaskId: string): Promise<BridgeQueryVideoTaskResponse> {
    const response = await this.request(
      `/v1/video/tasks/${encodeIdentifier(providerTaskId, "GET")}`,
      {
        method: "GET",
        operation: "GET",
        timeoutMs: this.requestTimeoutMs,
        retry: "SAFE_READ"
      }
    );
    return parseJsonResponse(
      response,
      bridgeQueryVideoTaskResponseSchema,
      "GET"
    );
  }

  async recoverTask(clientRequestId: string): Promise<string | null> {
    const response = await this.request(
      `/v1/video/submissions/${encodeIdentifier(clientRequestId, "RECOVER")}`,
      {
        method: "GET",
        operation: "RECOVER",
        timeoutMs: this.requestTimeoutMs,
        retry: "SAFE_READ"
      }
    );
    return (
      await parseJsonResponse(
        response,
        bridgeRecoverVideoTaskResponseSchema,
        "RECOVER"
      )
    ).id;
  }

  async cancelTask(
    providerTaskId: string
  ): Promise<BridgeQueryVideoTaskResponse> {
    const response = await this.request(
      `/v1/video/tasks/${encodeIdentifier(providerTaskId, "CANCEL")}`,
      {
        method: "DELETE",
        operation: "CANCEL",
        timeoutMs: this.requestTimeoutMs,
        retry: "NEVER"
      }
    );
    return parseJsonResponse(
      response,
      bridgeQueryVideoTaskResponseSchema,
      "CANCEL"
    );
  }

  async downloadOutput(providerTaskId: string): Promise<ProviderDownload> {
    const response = await this.request(
      `/v1/video/tasks/${encodeIdentifier(providerTaskId, "DOWNLOAD")}/output`,
      {
        method: "GET",
        operation: "DOWNLOAD",
        timeoutMs: this.downloadTimeoutMs,
        retry: "SAFE_READ"
      }
    );
    if (response.body === null) {
      throw new ProviderProtocolError(
        "DOWNLOAD",
        "Bridge output response has no body."
      );
    }
    const contentType = response.headers.get("content-type")?.split(";")[0];
    if (contentType === undefined || !contentType.startsWith("video/")) {
      await response.body.cancel();
      throw new ProviderDownloadValidationError(
        "Bridge output response has an invalid content type."
      );
    }
    const contentLength = parseContentLength(
      response.headers.get("content-length")
    );
    return {
      body: Readable.fromWeb(response.body),
      contentType,
      ...(contentLength === undefined ? {} : { contentLength })
    };
  }

  private async request(
    path: string,
    options: {
      method: "GET" | "POST" | "DELETE";
      operation: ProviderOperation;
      timeoutMs: number;
      retry: ProviderRetry;
      body?: string;
    }
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    timer.unref();
    try {
      const response = await this.fetchImplementation(
        `${this.baseUrl}${path}`,
        {
          method: options.method,
          headers: {
            Accept:
              options.operation === "DOWNLOAD"
                ? "video/*, application/json"
                : "application/json",
            Authorization: `Bearer ${this.token}`,
            ...(options.body === undefined
              ? {}
              : { "Content-Type": "application/json" })
          },
          ...(options.body === undefined ? {} : { body: options.body }),
          signal: controller.signal
        }
      );
      if (!response.ok) {
        await this.throwResponseError(
          response,
          options.operation,
          options.retry
        );
      }
      return response;
    } catch (error) {
      if (
        error instanceof ProviderAuthenticationError ||
        error instanceof ProviderDownloadValidationError ||
        error instanceof ProviderOutputExpiredError ||
        error instanceof ProviderRateLimitError ||
        error instanceof ProviderProtocolError ||
        error instanceof ProviderRequestError ||
        error instanceof ProviderTransientError ||
        error instanceof ProviderOutcomeUnknownError ||
        error instanceof ProviderUnsupportedOperationError
      ) {
        throw error;
      }
      if (options.operation === "CREATE") {
        throw new ProviderOutcomeUnknownError(error);
      }
      throw new ProviderTransientError(options.operation, { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  private async throwResponseError(
    response: Response,
    operation: ProviderOperation,
    retry: ProviderRetry
  ): Promise<never> {
    const structuredError = bridgeErrorResponseSchema.safeParse(
      await response.json().catch(() => undefined)
    );
    if (
      !structuredError.success ||
      structuredError.data.error.operation !== operation
    ) {
      throw new ProviderProtocolError(
        operation,
        "Bridge error response does not match the contract."
      );
    }
    if (
      response.status === 501 ||
      structuredError.data.error.code === "OPERATION_UNSUPPORTED"
    ) {
      throw new ProviderUnsupportedOperationError(operation);
    }
    if (response.status === 401 || response.status === 403) {
      throw new ProviderAuthenticationError(operation, response.status);
    }
    if (response.status === 429) {
      const contractRetryAfter = structuredError.data.error.retryAfterMs;
      throw new ProviderRateLimitError(
        operation,
        retry,
        contractRetryAfter ??
          parseRetryAfter(response.headers.get("retry-after"))
      );
    }
    if (operation === "DOWNLOAD" && response.status === 410) {
      throw new ProviderOutputExpiredError();
    }
    if (response.status >= 500) {
      if (operation === "CREATE") {
        throw new ProviderOutcomeUnknownError();
      }
      throw new ProviderTransientError(operation, {
        statusCode: response.status
      });
    }
    throw new ProviderRequestError(operation, response.status);
  }
}

async function parseJsonResponse<T>(
  response: Response,
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
  operation: ProviderOperation
): Promise<T> {
  const parsed = schema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) {
    throw new ProviderProtocolError(
      operation,
      "Bridge response does not match the contract."
    );
  }
  return parsed.data;
}

function parseBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Seedance Bridge URL must use HTTP or HTTPS.");
  }
  return url.toString().replace(/\/$/, "");
}

function encodeIdentifier(value: string, operation: ProviderOperation): string {
  if (value.trim().length === 0) {
    throw new ProviderProtocolError(operation, "Provider identifier is empty.");
  }
  return encodeURIComponent(value);
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds * 1_000 : undefined;
}
