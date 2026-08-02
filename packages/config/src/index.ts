import { resolve } from "node:path";

import { config as loadDotenv } from "dotenv";
import { z } from "zod";

const nodeEnvironmentSchema = z.enum(["development", "test", "production"]);
const providerNameSchema = z.preprocess(
  (value) => (value === "aicc" ? "seedance" : value),
  z.enum(["mock", "seedance"])
);
const assetPublisherSchema = z.enum(["hmac", "eos"]);

const optionalString = z.preprocess(
  emptyStringToUndefined,
  z.string().trim().min(1).optional()
);
const optionalUrl = z.preprocess(
  emptyStringToUndefined,
  z.string().url().optional()
);
const optionalPositiveInteger = z.preprocess(
  emptyStringToUndefined,
  z.coerce.number().int().positive().optional()
);
const booleanWithFalseDefault = z.preprocess((value) => {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}, z.boolean().default(false));

const commonSchema = z.object({
  NODE_ENV: nodeEnvironmentSchema.default("development"),
  DATABASE_URL: z
    .string()
    .min(1)
    .default(
      "postgresql://seedance:seedance-local-only@127.0.0.1:45432/seedance_console?schema=public"
    ),
  REDIS_URL: z.string().min(1).default("redis://127.0.0.1:46379"),
  STORAGE_ROOT: z.string().min(1).default("../../storage"),
  WORKER_HEARTBEAT_KEY: z.string().min(1).default("seedance:worker:heartbeat"),
  WORKER_HEARTBEAT_TTL_SECONDS: z.coerce.number().int().min(5).default(15)
});

const providerDefinitionFields = {
  SEEDANCE_PROVIDER: providerNameSchema.default("mock"),
  SEEDANCE_MODEL_ID: optionalString
};

const assetPublishingFields = {
  ASSET_PUBLISHER: assetPublisherSchema.default("hmac"),
  SEEDANCE_ASSET_SIGNING_KEY: z.preprocess(
    emptyStringToUndefined,
    z.string().min(32).optional()
  ),
  SEEDANCE_ASSET_PUBLIC_BASE_URL: optionalUrl,
  SEEDANCE_ASSET_URL_TTL_MS: optionalPositiveInteger,
  SEEDANCE_ASSET_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1_024)
    .default(10 * 1024 * 1024),
  APP_VIDEO_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1_024)
    .default(10 * 1024 * 1024),
  FFPROBE_PATH: z.string().trim().min(1).default("ffprobe"),
  EOS_ENDPOINT: optionalUrl,
  EOS_REGION: optionalString,
  EOS_BUCKET: optionalString,
  EOS_ACCESS_KEY_ID: optionalString,
  EOS_SECRET_ACCESS_KEY: optionalString,
  EOS_OBJECT_PREFIX: z.string().min(1).default("seedance-inputs/"),
  EOS_PRESIGN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(604_800)
    .default(3_600),
  EOS_FORCE_PATH_STYLE: booleanWithFalseDefault,
  EOS_DELETE_ON_TERMINAL: z.preprocess((value) => {
    if (value === "true") return true;
    if (value === "false") return false;
    return value;
  }, z.boolean().default(true))
};

const apiSchema = z
  .object({
    ...commonSchema.shape,
    ...providerDefinitionFields,
    ...assetPublishingFields,
    API_HOST: z.string().min(1).default("127.0.0.1"),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(43171),
    WEB_ORIGIN: z.string().url().default("http://localhost:43170"),
    UPLOAD_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1_024)
      .default(10 * 1024 * 1024)
  })
  .superRefine((value, context) => {
    requireSeedanceDefinition(value, context);
    requireCompleteAssetPublishingConfig(value, context);
  });

const workerSchema = z
  .object({
    ...commonSchema.shape,
    ...providerDefinitionFields,
    ...assetPublishingFields,
    WORKER_HOST: z.string().min(1).default("127.0.0.1"),
    WORKER_PORT: z.coerce.number().int().min(1).max(65535).default(43172),
    SEEDANCE_REQUEST_TIMEOUT_MS: optionalPositiveInteger,
    SEEDANCE_POLL_INTERVAL_MS: optionalPositiveInteger,
    SEEDANCE_MAX_POLL_INTERVAL_MS: optionalPositiveInteger,
    SEEDANCE_MAX_POLL_DURATION_MS: optionalPositiveInteger,
    SEEDANCE_DOWNLOAD_TIMEOUT_MS: optionalPositiveInteger,
    SEEDANCE_DOWNLOAD_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1_024)
      .default(512 * 1024 * 1024),
    SEEDANCE_DOWNLOAD_MAX_ATTEMPTS: z.coerce
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5),
    SEEDANCE_DOWNLOAD_RETRY_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(2_000),
    SEEDANCE_DOWNLOAD_MAX_RETRY_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(30_000),
    SEEDANCE_MAX_DOWNLOAD_DURATION_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(10 * 60_000),
    SEEDANCE_POLL_JITTER_RATIO: z.coerce.number().min(0).max(0.5).default(0.1),
    WORKER_RECONCILE_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(10_000),
    WORKER_RECONCILE_BATCH_SIZE: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000)
      .default(100),
    SEEDANCE_BRIDGE_URL: optionalUrl,
    SEEDANCE_BRIDGE_TOKEN: optionalString,
    REAL_API_TEST: booleanWithFalseDefault
  })
  .superRefine((value, context) => {
    requireSeedanceDefinition(value, context);
    requireCompleteAssetPublishingConfig(value, context);
    if (
      value.SEEDANCE_PROVIDER === "seedance" &&
      value.ASSET_PUBLISHER === "eos"
    ) {
      requireFields(
        value,
        [
          "EOS_ENDPOINT",
          "EOS_REGION",
          "EOS_BUCKET",
          "EOS_ACCESS_KEY_ID",
          "EOS_SECRET_ACCESS_KEY"
        ],
        context,
        "when SEEDANCE_PROVIDER=seedance and ASSET_PUBLISHER=eos"
      );
    }
    if (
      value.SEEDANCE_POLL_INTERVAL_MS !== undefined &&
      value.SEEDANCE_MAX_POLL_INTERVAL_MS !== undefined &&
      value.SEEDANCE_MAX_POLL_INTERVAL_MS < value.SEEDANCE_POLL_INTERVAL_MS
    ) {
      context.addIssue({
        code: "custom",
        path: ["SEEDANCE_MAX_POLL_INTERVAL_MS"],
        message:
          "SEEDANCE_MAX_POLL_INTERVAL_MS must be greater than or equal to SEEDANCE_POLL_INTERVAL_MS."
      });
    }
    if (
      value.SEEDANCE_DOWNLOAD_MAX_RETRY_INTERVAL_MS <
      value.SEEDANCE_DOWNLOAD_RETRY_INTERVAL_MS
    ) {
      context.addIssue({
        code: "custom",
        path: ["SEEDANCE_DOWNLOAD_MAX_RETRY_INTERVAL_MS"],
        message:
          "SEEDANCE_DOWNLOAD_MAX_RETRY_INTERVAL_MS must be greater than or equal to SEEDANCE_DOWNLOAD_RETRY_INTERVAL_MS."
      });
    }
    if (value.SEEDANCE_PROVIDER !== "seedance") return;
    requireFields(
      value,
      [
        "SEEDANCE_REQUEST_TIMEOUT_MS",
        "SEEDANCE_POLL_INTERVAL_MS",
        "SEEDANCE_MAX_POLL_INTERVAL_MS",
        "SEEDANCE_MAX_POLL_DURATION_MS",
        "SEEDANCE_DOWNLOAD_TIMEOUT_MS",
        "SEEDANCE_BRIDGE_URL",
        "SEEDANCE_BRIDGE_TOKEN"
      ],
      context,
      "when SEEDANCE_PROVIDER=seedance"
    );
  });

const seedanceBridgeSchema = z.object({
  SEEDANCE_BASE_URL: z.string().url(),
  SEEDANCE_API_KEY: z.string().trim().min(1),
  SEEDANCE_MODEL_ID: z.string().trim().min(1),
  SEEDANCE_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive(),
  SEEDANCE_DOWNLOAD_TIMEOUT_MS: z.coerce.number().int().positive(),
  SEEDANCE_BRIDGE_TOKEN: z.string().trim().min(1),
  REAL_API_TEST: booleanWithFalseDefault
});

export type ApiConfig = z.infer<typeof apiSchema>;
export type WorkerConfig = z.infer<typeof workerSchema>;
export type SeedanceBridgeConfig = z.infer<typeof seedanceBridgeSchema>;

export function loadLocalEnvironment(path = defaultEnvironmentPath()): void {
  loadDotenv({ path, quiet: true });
}

export function loadApiConfig(
  environment: NodeJS.ProcessEnv = process.env
): ApiConfig {
  return apiSchema.parse(environment);
}

export function loadWorkerConfig(
  environment: NodeJS.ProcessEnv = process.env
): WorkerConfig {
  return workerSchema.parse(environment);
}

export function loadSeedanceBridgeConfig(
  environment: NodeJS.ProcessEnv = process.env
): SeedanceBridgeConfig {
  return seedanceBridgeSchema.parse(environment);
}

export function hasAssetPublishingConfig(value: {
  ASSET_PUBLISHER?: "hmac" | "eos" | undefined;
  SEEDANCE_ASSET_SIGNING_KEY?: string | undefined;
  SEEDANCE_ASSET_PUBLIC_BASE_URL?: string | undefined;
  SEEDANCE_ASSET_URL_TTL_MS?: number | undefined;
}): value is {
  SEEDANCE_ASSET_SIGNING_KEY: string;
  SEEDANCE_ASSET_PUBLIC_BASE_URL: string;
  SEEDANCE_ASSET_URL_TTL_MS: number;
} {
  return (
    value.ASSET_PUBLISHER !== "eos" &&
    value.SEEDANCE_ASSET_SIGNING_KEY !== undefined &&
    value.SEEDANCE_ASSET_PUBLIC_BASE_URL !== undefined &&
    value.SEEDANCE_ASSET_URL_TTL_MS !== undefined
  );
}

export function hasEosAssetPublishingConfig(value: {
  ASSET_PUBLISHER: "hmac" | "eos";
  EOS_ENDPOINT?: string | undefined;
  EOS_REGION?: string | undefined;
  EOS_BUCKET?: string | undefined;
  EOS_ACCESS_KEY_ID?: string | undefined;
  EOS_SECRET_ACCESS_KEY?: string | undefined;
}): value is typeof value & {
  ASSET_PUBLISHER: "eos";
  EOS_ENDPOINT: string;
  EOS_REGION: string;
  EOS_BUCKET: string;
  EOS_ACCESS_KEY_ID: string;
  EOS_SECRET_ACCESS_KEY: string;
} {
  return (
    value.ASSET_PUBLISHER === "eos" &&
    value.EOS_ENDPOINT !== undefined &&
    value.EOS_REGION !== undefined &&
    value.EOS_BUCKET !== undefined &&
    value.EOS_ACCESS_KEY_ID !== undefined &&
    value.EOS_SECRET_ACCESS_KEY !== undefined
  );
}

function requireSeedanceDefinition(
  value: {
    SEEDANCE_PROVIDER: "mock" | "seedance";
    SEEDANCE_MODEL_ID?: string | undefined;
  },
  context: z.RefinementCtx
): void {
  if (
    value.SEEDANCE_PROVIDER === "seedance" &&
    value.SEEDANCE_MODEL_ID === undefined
  ) {
    addRequiredIssue(
      context,
      "SEEDANCE_MODEL_ID",
      "when SEEDANCE_PROVIDER=seedance"
    );
  }
}

function requireFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  context: z.RefinementCtx,
  condition: string
): void {
  for (const field of fields) {
    if (value[field] === undefined) {
      addRequiredIssue(context, field, condition);
    }
  }
}

function requireCompleteAssetPublishingConfig(
  value: {
    ASSET_PUBLISHER?: "hmac" | "eos" | undefined;
    SEEDANCE_ASSET_SIGNING_KEY?: string | undefined;
    SEEDANCE_ASSET_PUBLIC_BASE_URL?: string | undefined;
    SEEDANCE_ASSET_URL_TTL_MS?: number | undefined;
  },
  context: z.RefinementCtx
): void {
  if (value.ASSET_PUBLISHER === "eos") return;
  const fields = [
    "SEEDANCE_ASSET_SIGNING_KEY",
    "SEEDANCE_ASSET_PUBLIC_BASE_URL",
    "SEEDANCE_ASSET_URL_TTL_MS"
  ] as const;
  if (fields.every((field) => value[field] === undefined)) return;
  requireFields(
    value,
    fields,
    context,
    "when any Provider asset publishing setting is configured"
  );
}

function addRequiredIssue(
  context: z.RefinementCtx,
  field: string,
  condition: string
): void {
  context.addIssue({
    code: "custom",
    path: [field],
    message: `${field} is required ${condition}.`
  });
}

function emptyStringToUndefined(value: unknown): unknown {
  return typeof value === "string" && value.trim().length === 0
    ? undefined
    : value;
}

function defaultEnvironmentPath(): string {
  return process.env.ENV_FILE ?? resolve(process.cwd(), "../../.env");
}
