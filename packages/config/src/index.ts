import { resolve } from "node:path";

import { config as loadDotenv } from "dotenv";
import { z } from "zod";

const nodeEnvironmentSchema = z.enum(["development", "test", "production"]);

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

const apiSchema = commonSchema.extend({
  API_HOST: z.string().min(1).default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(43171),
  WEB_ORIGIN: z.string().url().default("http://localhost:43170"),
  UPLOAD_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1_024)
    .default(10 * 1024 * 1024)
});

const workerSchema = commonSchema.extend({
  WORKER_HOST: z.string().min(1).default("127.0.0.1"),
  WORKER_PORT: z.coerce.number().int().min(1).max(65535).default(43172),
  SEEDANCE_PROVIDER_DRIVER: z.literal("mock").default("mock")
});

export type ApiConfig = z.infer<typeof apiSchema>;
export type WorkerConfig = z.infer<typeof workerSchema>;

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

function defaultEnvironmentPath(): string {
  return process.env.ENV_FILE ?? resolve(process.cwd(), "../../.env");
}
