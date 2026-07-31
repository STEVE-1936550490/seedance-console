import { resolve } from "node:path";

import { config as loadDotenv } from "dotenv";
import { z } from "zod";

const nodeEnvironmentSchema = z.enum(["development", "test", "production"]);
const providerNameSchema = z.enum(["mock", "seedance"]);

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

const apiSchema = z
  .object({
    ...commonSchema.shape,
    ...providerDefinitionFields,
    API_HOST: z.string().min(1).default("127.0.0.1"),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(43171),
    WEB_ORIGIN: z.string().url().default("http://localhost:43170"),
    UPLOAD_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1_024)
      .default(10 * 1024 * 1024)
  })
  .superRefine(requireSeedanceDefinition);

const workerSchema = z
  .object({
    ...commonSchema.shape,
    ...providerDefinitionFields,
    WORKER_HOST: z.string().min(1).default("127.0.0.1"),
    WORKER_PORT: z.coerce.number().int().min(1).max(65535).default(43172),
    SEEDANCE_REQUEST_TIMEOUT_MS: optionalPositiveInteger,
    SEEDANCE_POLL_INTERVAL_MS: optionalPositiveInteger,
    SEEDANCE_MAX_POLL_INTERVAL_MS: optionalPositiveInteger,
    SEEDANCE_MAX_POLL_DURATION_MS: optionalPositiveInteger,
    SEEDANCE_DOWNLOAD_TIMEOUT_MS: optionalPositiveInteger,
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
