export type ProviderOperation =
  | "HEALTH"
  | "VALIDATE"
  | "CREATE"
  | "RECOVER"
  | "GET"
  | "CANCEL"
  | "DOWNLOAD"
  | "NORMALIZE";

export type ProviderRetry =
  "NEVER" | "SAFE_READ" | "IDEMPOTENT_ONLY" | "MANUAL_RECONCILIATION";

export interface ProviderOperationErrorOptions {
  code: string;
  operation: ProviderOperation;
  retry: ProviderRetry;
  safeMessage: string;
  statusCode?: number;
  retryAfterMs?: number;
  cause?: unknown;
  audit?: ProviderCreateAudit;
}

export interface ProviderCreateAudit {
  bridgeRequestId?: string | undefined;
  requestStartedAt?: string | undefined;
  requestEndedAt?: string | undefined;
  failureStage?: string | undefined;
  exceptionType?: string | undefined;
  requestBodySent?: boolean | undefined;
  providerHttpStatus?: number | undefined;
  providerErrorCode?: string | undefined;
  providerRequestId?: string | undefined;
  providerTraceId?: string | undefined;
}

export class ProviderOperationError extends Error {
  readonly code: string;
  readonly operation: ProviderOperation;
  readonly retry: ProviderRetry;
  readonly statusCode?: number;
  readonly retryAfterMs?: number;
  readonly audit: ProviderCreateAudit | undefined;

  constructor(options: ProviderOperationErrorOptions) {
    super(options.safeMessage, { cause: options.cause });
    this.name = "ProviderOperationError";
    this.code = options.code;
    this.operation = options.operation;
    this.retry = options.retry;
    if (options.statusCode !== undefined) {
      this.statusCode = options.statusCode;
    }
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
    this.audit = options.audit;
  }

  get retryable(): boolean {
    return this.retry === "SAFE_READ" || this.retry === "IDEMPOTENT_ONLY";
  }
}

export class ProviderAuthenticationError extends ProviderOperationError {
  constructor(operation: ProviderOperation, statusCode = 401) {
    super({
      code: "PROVIDER_AUTHENTICATION_FAILED",
      operation,
      retry: "NEVER",
      safeMessage: "Provider authentication failed.",
      statusCode
    });
    this.name = "ProviderAuthenticationError";
  }
}

export class ProviderValidationError extends ProviderOperationError {
  constructor(safeMessage = "Provider input validation failed.") {
    super({
      code: "PROVIDER_INVALID_PARAMETERS",
      operation: "VALIDATE",
      retry: "NEVER",
      safeMessage
    });
    this.name = "ProviderValidationError";
  }
}

export class ProviderRateLimitError extends ProviderOperationError {
  constructor(
    operation: ProviderOperation,
    retry: ProviderRetry,
    retryAfterMs?: number
  ) {
    super({
      code: "PROVIDER_RATE_LIMITED",
      operation,
      retry,
      safeMessage: "Provider rate limit exceeded.",
      statusCode: 429,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs })
    });
    this.name = "ProviderRateLimitError";
  }
}

export class ProviderTransientError extends ProviderOperationError {
  constructor(
    operation: ProviderOperation,
    options: {
      statusCode?: number;
      cause?: unknown;
      safeMessage?: string;
    } = {}
  ) {
    super({
      code: "PROVIDER_TRANSIENT_ERROR",
      operation,
      retry: "SAFE_READ",
      safeMessage:
        options.safeMessage ?? "Provider operation temporarily failed.",
      ...(options.statusCode === undefined
        ? {}
        : { statusCode: options.statusCode }),
      ...(options.cause === undefined ? {} : { cause: options.cause })
    });
    this.name = "ProviderTransientError";
  }
}

export class ProviderOutcomeUnknownError extends ProviderOperationError {
  constructor(cause?: unknown, audit?: ProviderCreateAudit) {
    super({
      code: "PROVIDER_CREATE_OUTCOME_UNKNOWN",
      operation: "CREATE",
      retry: "MANUAL_RECONCILIATION",
      safeMessage: "Provider create outcome is unknown.",
      ...(cause === undefined ? {} : { cause }),
      ...(audit === undefined ? {} : { audit })
    });
    this.name = "ProviderOutcomeUnknownError";
  }
}

export class ProviderCreateNotSentError extends ProviderOperationError {
  constructor(cause?: unknown, audit?: ProviderCreateAudit) {
    super({
      code: "PROVIDER_CREATE_NOT_SENT",
      operation: "CREATE",
      retry: "NEVER",
      safeMessage: "Provider create was not sent.",
      ...(cause === undefined ? {} : { cause }),
      ...(audit === undefined ? {} : { audit })
    });
    this.name = "ProviderCreateNotSentError";
  }
}

export class ProviderProtocolError extends ProviderOperationError {
  constructor(operation: ProviderOperation, safeMessage: string) {
    super({
      code: "PROVIDER_PROTOCOL_ERROR",
      operation,
      retry: "NEVER",
      safeMessage
    });
    this.name = "ProviderProtocolError";
  }
}

export class ProviderOutputExpiredError extends ProviderOperationError {
  constructor() {
    super({
      code: "PROVIDER_OUTPUT_EXPIRED",
      operation: "DOWNLOAD",
      retry: "NEVER",
      safeMessage: "Provider output is no longer available."
    });
    this.name = "ProviderOutputExpiredError";
  }
}

export class ProviderDownloadValidationError extends ProviderOperationError {
  constructor(safeMessage = "Provider output failed validation.") {
    super({
      code: "PROVIDER_OUTPUT_INVALID",
      operation: "DOWNLOAD",
      retry: "NEVER",
      safeMessage
    });
    this.name = "ProviderDownloadValidationError";
  }
}

export class ProviderRequestError extends ProviderOperationError {
  constructor(
    operation: ProviderOperation,
    statusCode: number,
    audit?: ProviderCreateAudit
  ) {
    super({
      code: "PROVIDER_REQUEST_REJECTED",
      operation,
      retry: "NEVER",
      safeMessage: "Provider request was rejected.",
      statusCode,
      ...(audit === undefined ? {} : { audit })
    });
    this.name = "ProviderRequestError";
  }
}

export class ProviderUnsupportedOperationError extends ProviderOperationError {
  constructor(operation: ProviderOperation) {
    super({
      code: "PROVIDER_OPERATION_UNSUPPORTED",
      operation,
      retry: "NEVER",
      safeMessage: "Provider operation is not supported."
    });
    this.name = "ProviderUnsupportedOperationError";
  }
}
