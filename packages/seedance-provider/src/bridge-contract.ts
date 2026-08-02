import { z } from "zod";

const bridgeTextContentSchema = z
  .object({
    type: z.literal("text"),
    text: z.string().min(1)
  })
  .strict();

const bridgeImageContentSchema = z
  .object({
    type: z.literal("image_url"),
    image_url: z.object({ url: z.string().url() }).strict(),
    role: z.literal("reference_image")
  })
  .strict();

const bridgeReferenceVideoContentSchema = z
  .object({
    type: z.literal("video_url"),
    video_url: z.object({ url: z.string().url() }).strict(),
    role: z.literal("reference_video")
  })
  .strict();

export const bridgeVideoContentSchema = z.discriminatedUnion("type", [
  bridgeTextContentSchema,
  bridgeImageContentSchema,
  bridgeReferenceVideoContentSchema
]);

const bridgeContentSchema = z.union([
  z.tuple([bridgeTextContentSchema]),
  z.tuple([bridgeTextContentSchema, bridgeImageContentSchema]),
  z.tuple([bridgeTextContentSchema, bridgeReferenceVideoContentSchema])
]);

export const bridgeCreateVideoTaskRequestSchema = z
  .object({
    clientRequestId: z.string().min(1).max(128),
    createAttemptId: z.string().min(1).max(128).optional(),
    requestPayloadSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    model: z.string().min(1),
    request: z
      .object({
        content: bridgeContentSchema,
        generate_audio: z.boolean(),
        ratio: z.literal("16:9"),
        duration: z.literal(11),
        watermark: z.literal(false)
      })
      .strict()
  })
  .strict();

const iso8601InstantSchema = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());

const bridgeCreateAuditSchema = z
  .object({
    bridgeRequestId: z.string().min(1).max(128),
    requestStartedAt: iso8601InstantSchema.optional(),
    requestEndedAt: iso8601InstantSchema.optional(),
    failureStage: z.string().min(1).max(128).optional(),
    exceptionType: z.string().min(1).max(128).optional(),
    requestBodySent: z.boolean().optional(),
    providerHttpStatus: z.number().int().optional(),
    providerErrorCode: z.string().min(1).max(128).optional(),
    providerRequestId: z.string().min(1).max(128).optional(),
    providerTraceId: z.string().min(1).max(128).optional()
  })
  .strict();

export const bridgeCreateVideoTaskResponseSchema = z
  .object({
    id: z.string().min(1),
    audit: bridgeCreateAuditSchema.optional()
  })
  .strict();

export const bridgeRecoverVideoTaskResponseSchema = z
  .object({
    id: z.string().min(1).nullable()
  })
  .strict();

export const bridgeRecoverVideoTaskRequestSchema = z
  .object({
    clientRequestId: z.string().min(1).max(128)
  })
  .strict();

export const bridgeQueryVideoTaskResponseSchema = z
  .object({
    status: z.string().min(1),
    content: z
      .object({
        video_url: z.string().url().optional()
      })
      .strict()
      .optional(),
    error: z.unknown().optional()
  })
  .strict();

export const bridgeHealthResponseSchema = z
  .object({
    status: z.literal("ok"),
    capabilities: z
      .object({
        cancellation: z.boolean()
      })
      .strict()
  })
  .strict();

export const bridgeErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1),
        operation: z.enum([
          "HEALTH",
          "CREATE",
          "RECOVER",
          "GET",
          "CANCEL",
          "DOWNLOAD"
        ]),
        retry: z.enum([
          "NEVER",
          "SAFE_READ",
          "IDEMPOTENT_ONLY",
          "MANUAL_RECONCILIATION"
        ]),
        retryAfterMs: z.number().int().nonnegative().optional(),
        requestId: z.string().min(1).optional(),
        audit: bridgeCreateAuditSchema.optional()
      })
      .strict()
  })
  .strict();

export type BridgeVideoContent = z.infer<typeof bridgeVideoContentSchema>;
export type BridgeCreateVideoTaskRequest = z.infer<
  typeof bridgeCreateVideoTaskRequestSchema
>;
export type BridgeCreateVideoTaskResponse = z.infer<
  typeof bridgeCreateVideoTaskResponseSchema
>;
export type BridgeRecoverVideoTaskResponse = z.infer<
  typeof bridgeRecoverVideoTaskResponseSchema
>;
export type BridgeRecoverVideoTaskRequest = z.infer<
  typeof bridgeRecoverVideoTaskRequestSchema
>;
export type BridgeQueryVideoTaskResponse = z.infer<
  typeof bridgeQueryVideoTaskResponseSchema
>;
export type BridgeHealthResponse = z.infer<typeof bridgeHealthResponseSchema>;
export type BridgeErrorResponse = z.infer<typeof bridgeErrorResponseSchema>;
