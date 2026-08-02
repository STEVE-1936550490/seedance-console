import { createHash, randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import { Readable } from "node:stream";

import multipart from "@fastify/multipart";
import { AssetKind, AssetRole } from "@prisma/client";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Queue } from "bullmq";
import { z } from "zod";

import type {
  ProviderCapabilities,
  ProviderDefinition
} from "@seedance/seedance-provider";
import type {
  ProviderSubmitJob,
  TaskDto,
  TaskListResponse,
  VideoGenerationJob
} from "@seedance/shared";
import { providerJobId } from "@seedance/shared";
import {
  AssetPublishingError as StorageAssetPublishingError,
  inspectMp4Video,
  isSupportedProviderImageMimeType,
  isSupportedProviderVideoMimeType,
  type AssetPublisher,
  type Storage,
  type VideoMetadata
} from "@seedance/storage";

const createTaskSchema = z.object({
  clientRequestId: z.string().min(8).max(128),
  model: z.string().min(1).max(128),
  prompt: z.string().trim().min(1).max(5_000),
  assetIds: z.array(z.string().min(1)).max(8).default([]),
  parameters: z.record(z.string(), z.unknown())
});

const taskParamsSchema = z.object({ taskId: z.string().min(1) });
const providerAssetParamsSchema = z
  .object({ assetId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) })
  .strict();
const providerAssetQuerySchema = z
  .object({
    provider: z.literal("seedance"),
    purpose: z.enum(["reference-image", "reference-video"]),
    expires: z.string().regex(/^\d{1,16}$/),
    signature: z.string().min(1).max(128)
  })
  .strict();

export interface MvpRouteDependencies {
  prisma: PrismaClient;
  provider: ProviderDefinition;
  taskQueue: Queue<VideoGenerationJob>;
  storage: Storage;
  uploadMaxBytes: number;
  appVideoMaxBytes?: number;
  ffprobePath?: string;
  assetPublisher?: AssetPublisher;
  assetPublishingConfigured?: boolean;
}

export async function registerMvpRoutes(
  server: FastifyInstance,
  dependencies: MvpRouteDependencies
): Promise<void> {
  await server.register(multipart, {
    limits: {
      files: 1,
      fileSize: Math.max(
        dependencies.uploadMaxBytes,
        dependencies.appVideoMaxBytes ?? dependencies.uploadMaxBytes
      )
    }
  });

  server.get(
    "/api/providers/capabilities",
    async (): Promise<ProviderCapabilities> =>
      dependencies.provider.getCapabilities()
  );

  server.post("/api/assets", async (request, reply) => {
    const file = await request.file();
    if (file === undefined) {
      return reply.code(400).send({ error: "ASSET_REQUIRED" });
    }
    if (file.mimetype === "video/mp4") {
      return uploadVideoAsset(file, reply, dependencies);
    }
    if (!allowedImageTypes.has(file.mimetype)) {
      return reply.code(415).send({ error: "UNSUPPORTED_ASSET_TYPE" });
    }

    const content = await file.toBuffer();
    const extension = imageExtensions[file.mimetype];
    if (extension === undefined) {
      return reply.code(415).send({ error: "UNSUPPORTED_IMAGE_TYPE" });
    }

    const storageKey = `inputs/${randomUUID()}${extension}`;
    const originalName = sanitizeFileName(file.filename);
    await dependencies.storage.put(storageKey, Readable.from(content));

    try {
      const asset = await dependencies.prisma.asset.create({
        data: {
          kind: AssetKind.INPUT_IMAGE,
          storageKey,
          originalName,
          mimeType: file.mimetype,
          sizeBytes: content.byteLength,
          checksum: createHash("sha256").update(content).digest("hex")
        }
      });
      return reply.code(201).send({
        id: asset.id,
        originalName: asset.originalName,
        mimeType: asset.mimeType,
        sizeBytes: Number(asset.sizeBytes),
        kind: "image",
        durationSeconds: null,
        width: null,
        height: null,
        codec: null,
        frameRate: null,
        hasAudio: null
      });
    } catch (error) {
      await dependencies.storage.delete(storageKey).catch(() => undefined);
      throw error;
    }
  });

  server.route({
    method: ["GET", "HEAD"],
    url: "/api/provider-assets/:assetId",
    logLevel: "silent",
    handler: async (request, reply) => {
      if (dependencies.assetPublisher === undefined) {
        return reply
          .code(503)
          .send({ error: "ASSET_PUBLISHING_NOT_CONFIGURED" });
      }
      const params = providerAssetParamsSchema.safeParse(request.params);
      const query = providerAssetQuerySchema.safeParse(request.query);
      if (!params.success || !query.success) {
        return reply.code(403).send({ error: "ASSET_SIGNATURE_INVALID" });
      }
      try {
        const asset = await dependencies.assetPublisher.authorizeProviderAsset({
          assetId: params.data.assetId,
          ...query.data
        });
        reply.header("Content-Type", asset.mimeType);
        reply.header("Content-Length", String(asset.sizeBytes));
        reply.header("ETag", `"${asset.checksum}"`);
        reply.header("Cache-Control", "private, no-store");
        reply.header("Accept-Ranges", "none");
        if (request.method === "HEAD") return reply.send();
        return reply.send(
          dependencies.storage.openReadStream(asset.storageKey)
        );
      } catch (error) {
        return sendAssetPublishingError(reply, error);
      }
    }
  });
  server.route({
    method: ["DELETE", "OPTIONS", "PATCH", "POST", "PUT", "TRACE"],
    url: "/api/provider-assets/:assetId",
    logLevel: "silent",
    handler: async (_request, reply) =>
      reply.code(405).send({ error: "METHOD_NOT_ALLOWED" })
  });

  server.post("/api/tasks", async (request, reply) => {
    const parsed = createTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "INVALID_TASK",
        issues: parsed.error.issues
      });
    }

    const validation = dependencies.provider.validateParameters(
      parsed.data.model,
      parsed.data.parameters
    );
    if (!validation.ok) {
      return reply.code(400).send({
        error: "INVALID_PROVIDER_PARAMETERS",
        issues: validation.issues
      });
    }

    const capabilities = await dependencies.provider.getCapabilities();
    if (
      dependencies.provider.name === "seedance" &&
      parsed.data.assetIds.length > 0 &&
      !(
        dependencies.assetPublishingConfigured ??
        dependencies.assetPublisher !== undefined
      )
    ) {
      return reply.code(400).send({
        error: "ASSET_PUBLISHING_NOT_CONFIGURED",
        message: "Reference asset publishing is not configured."
      });
    }

    const existing = await dependencies.prisma.videoTask.findUnique({
      where: { clientRequestId: parsed.data.clientRequestId }
    });
    let taskId = existing?.id;

    if (taskId === undefined) {
      const assets =
        parsed.data.assetIds.length === 0
          ? []
          : await dependencies.prisma.asset.findMany({
              where: {
                id: { in: parsed.data.assetIds },
                kind: { in: [AssetKind.INPUT_IMAGE, AssetKind.INPUT_VIDEO] }
              }
            });
      if (assets.length !== new Set(parsed.data.assetIds).size) {
        return reply.code(400).send({ error: "INVALID_REFERENCE_ASSET" });
      }
      const images = assets.filter(
        (asset) => asset.kind === AssetKind.INPUT_IMAGE
      );
      const videos = assets.filter(
        (asset) => asset.kind === AssetKind.INPUT_VIDEO
      );
      if (!capabilities.supportsReferenceImage && images.length > 0) {
        return reply.code(400).send({ error: "REFERENCE_IMAGES_UNSUPPORTED" });
      }
      if (images.length > capabilities.maxReferenceImages) {
        return reply.code(400).send({ error: "TOO_MANY_REFERENCE_IMAGES" });
      }
      if (!capabilities.supportsReferenceVideo && videos.length > 0) {
        return reply.code(400).send({ error: "REFERENCE_VIDEOS_UNSUPPORTED" });
      }
      if (videos.length > capabilities.maxReferenceVideos) {
        return reply.code(400).send({ error: "TOO_MANY_REFERENCE_VIDEOS" });
      }
      if (
        dependencies.provider.name === "seedance" &&
        images.length + videos.length > 1
      ) {
        return reply.code(400).send({ error: "TOO_MANY_REFERENCE_ASSETS" });
      }
      if (
        dependencies.provider.name === "seedance" &&
        images.some(
          (asset) => !isSupportedProviderImageMimeType(asset.mimeType)
        )
      ) {
        return reply.code(400).send({
          error: "UNSUPPORTED_REFERENCE_IMAGE_TYPE",
          message: "Seedance reference images must be PNG or JPEG."
        });
      }
      if (
        dependencies.provider.name === "seedance" &&
        videos.some(
          (asset) => !isSupportedProviderVideoMimeType(asset.mimeType)
        )
      ) {
        return reply.code(400).send({
          error: "UNSUPPORTED_REFERENCE_VIDEO_TYPE",
          message: "Seedance MVP reference videos must be MP4."
        });
      }

      const task = await dependencies.prisma.videoTask.create({
        data: {
          clientRequestId: parsed.data.clientRequestId,
          provider: dependencies.provider.name,
          model: parsed.data.model,
          prompt: parsed.data.prompt,
          parameters: validation.value as unknown as Prisma.InputJsonValue,
          status: "QUEUED",
          events: {
            create: {
              toStatus: "QUEUED",
              reason: "TASK_CREATED"
            }
          },
          assets: {
            create: assets.map((asset, position) => ({
              assetId: asset.id,
              role:
                asset.kind === AssetKind.INPUT_VIDEO
                  ? AssetRole.REFERENCE_VIDEO
                  : AssetRole.REFERENCE_IMAGE,
              position
            }))
          }
        }
      });
      taskId = task.id;
    }

    const submitJob: ProviderSubmitJob = {
      kind: "provider-submit",
      taskId
    };
    await dependencies.taskQueue.add(submitJob.kind, submitJob, {
      jobId: providerJobId(submitJob),
      attempts: 1,
      backoff: { type: "fixed", delay: 1_000 },
      removeOnComplete: true,
      removeOnFail: 100
    });

    const task = await findTask(dependencies.prisma, taskId);
    return reply.code(existing === null ? 202 : 200).send(toTaskDto(task));
  });

  server.get("/api/tasks", async (): Promise<TaskListResponse> => {
    const tasks = await dependencies.prisma.videoTask.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      include: taskInclude
    });
    return { tasks: tasks.map(toTaskDto) };
  });

  server.get("/api/tasks/:taskId", async (request, reply) => {
    const params = taskParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "INVALID_TASK_ID" });
    }
    const task = await dependencies.prisma.videoTask.findUnique({
      where: { id: params.data.taskId },
      include: taskInclude
    });
    return task === null
      ? reply.code(404).send({ error: "TASK_NOT_FOUND" })
      : toTaskDto(task);
  });

  server.post("/api/tasks/:taskId/cancel", async (request, reply) => {
    const params = taskParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "INVALID_TASK_ID" });
    }

    const current = await dependencies.prisma.videoTask.findUnique({
      where: { id: params.data.taskId }
    });
    if (current === null) {
      return reply.code(404).send({ error: "TASK_NOT_FOUND" });
    }

    if (
      current.status === "QUEUED" ||
      current.status === "SUBMITTING" ||
      current.status === "PROCESSING"
    ) {
      await dependencies.prisma.$transaction(async (transaction) => {
        const cancelled = await transaction.videoTask.updateMany({
          where: {
            id: params.data.taskId,
            status: { in: ["QUEUED", "SUBMITTING", "PROCESSING"] }
          },
          data: {
            status: "CANCELLED",
            completedAt: new Date()
          }
        });
        if (cancelled.count === 1) {
          await transaction.taskEvent.create({
            data: {
              taskId: params.data.taskId,
              fromStatus: current.status,
              toStatus: "CANCELLED",
              reason: "USER_CANCELLED"
            }
          });
        }
      });
    }

    const task = await findTask(dependencies.prisma, params.data.taskId);
    return reply.send(toTaskDto(task));
  });

  server.get("/api/tasks/:taskId/video", async (request, reply) =>
    sendVideo(request.params, reply, dependencies, false)
  );
  server.get("/api/tasks/:taskId/download", async (request, reply) =>
    sendVideo(request.params, reply, dependencies, true)
  );
}

async function uploadVideoAsset(
  file: {
    filename: string;
    mimetype: string;
    file: Readable;
  },
  reply: FastifyReply,
  dependencies: MvpRouteDependencies
) {
  if (extname(file.filename).toLowerCase() !== ".mp4") {
    file.file.resume();
    return reply.code(415).send({ error: "VIDEO_EXTENSION_MISMATCH" });
  }
  const storageKey = `inputs/videos/${randomUUID()}.mp4`;
  let metadata: VideoMetadata | undefined;
  try {
    const stored = await dependencies.storage.putAtomic(storageKey, file.file, {
      maxBytes: dependencies.appVideoMaxBytes ?? dependencies.uploadMaxBytes,
      timeoutMs: 30_000,
      validate: async (candidate) => {
        metadata = await inspectMp4Video(candidate, {
          minDurationSeconds: 2,
          maxDurationSeconds: 15,
          ...(dependencies.ffprobePath === undefined
            ? {}
            : { ffprobePath: dependencies.ffprobePath })
        });
      }
    });
    if (metadata === undefined) {
      throw new Error("Video metadata was not produced.");
    }
    const originalName = sanitizeFileName(file.filename);
    try {
      const asset = await dependencies.prisma.asset.create({
        data: {
          kind: AssetKind.INPUT_VIDEO,
          storageKey,
          originalName,
          mimeType: "video/mp4",
          sizeBytes: stored.sizeBytes,
          checksum: stored.sha256,
          durationMs: Math.round(metadata.durationSeconds * 1_000),
          width: metadata.width,
          height: metadata.height,
          codec: metadata.codec,
          pixelFormat: metadata.pixelFormat,
          frameRate: metadata.frameRate,
          hasAudio: metadata.hasAudio
        }
      });
      return reply.code(201).send({
        id: asset.id,
        originalName: asset.originalName,
        mimeType: asset.mimeType,
        sizeBytes: Number(asset.sizeBytes),
        kind: "video",
        durationSeconds: metadata.durationSeconds,
        width: metadata.width,
        height: metadata.height,
        codec: metadata.codec,
        frameRate: metadata.frameRate,
        hasAudio: metadata.hasAudio
      });
    } catch (error) {
      await dependencies.storage.delete(storageKey).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "VIDEO_FILE_INVALID" ||
        error.code === "STORAGE_SIZE_LIMIT_EXCEEDED")
    ) {
      return reply.code(422).send({ error: String(error.code) });
    }
    throw error;
  }
}

function sendAssetPublishingError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof StorageAssetPublishingError)) throw error;
  switch (error.code) {
    case "ASSET_SIGNATURE_INVALID":
    case "ASSET_URL_EXPIRED":
    case "ASSET_PUBLISHING_INVALID_REQUEST":
      return reply.code(403).send({ error: error.code });
    case "ASSET_NOT_FOUND":
    case "ASSET_FILE_MISSING":
      return reply.code(404).send({ error: error.code });
    case "ASSET_TYPE_UNSUPPORTED":
    case "ASSET_EMPTY":
    case "ASSET_TOO_LARGE":
    case "ASSET_METADATA_MISMATCH":
    case "ASSET_FILE_INVALID":
      return reply.code(422).send({ error: error.code });
    default:
      return reply.code(503).send({ error: error.code });
  }
}

const taskInclude = {
  assets: {
    include: { asset: true },
    orderBy: { position: "asc" as const }
  },
  usageRecords: {
    orderBy: { recordedAt: "asc" as const }
  }
} satisfies Prisma.VideoTaskInclude;

type TaskWithRelations = Prisma.VideoTaskGetPayload<{
  include: typeof taskInclude;
}>;

async function findTask(
  prisma: PrismaClient,
  taskId: string
): Promise<TaskWithRelations> {
  const task = await prisma.videoTask.findUniqueOrThrow({
    where: { id: taskId },
    include: taskInclude
  });
  return task;
}

function toTaskDto(task: TaskWithRelations): TaskDto {
  const referenceAssets = task.assets
    .filter(
      (relation) =>
        relation.role === AssetRole.REFERENCE_IMAGE ||
        relation.role === AssetRole.REFERENCE_VIDEO
    )
    .map((relation) => ({
      id: relation.asset.id,
      originalName: relation.asset.originalName,
      mimeType: relation.asset.mimeType,
      kind:
        relation.role === AssetRole.REFERENCE_VIDEO
          ? ("video" as const)
          : ("image" as const),
      sizeBytes: Number(relation.asset.sizeBytes),
      durationSeconds:
        relation.asset.durationMs === null
          ? null
          : relation.asset.durationMs / 1_000,
      width: relation.asset.width,
      height: relation.asset.height,
      codec: relation.asset.codec,
      frameRate: relation.asset.frameRate,
      hasAudio: relation.asset.hasAudio
    }));

  return {
    id: task.id,
    clientRequestId: task.clientRequestId,
    provider: task.provider,
    providerTaskId: task.providerTaskId,
    model: task.model,
    status: task.status,
    prompt: task.prompt,
    parameters: task.parameters as Record<string, unknown>,
    errorCode: task.errorCode,
    errorMessage: task.errorMessage,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    submittedAt: task.submittedAt?.toISOString() ?? null,
    completedAt: task.completedAt?.toISOString() ?? null,
    referenceAssets,
    usage: task.usageRecords.map((usage) => ({
      metric: usage.metric,
      quantity: usage.quantity.toString(),
      unit: usage.unit
    })),
    hasVideo: task.assets.some(
      (relation) => relation.role === AssetRole.GENERATED_VIDEO
    )
  };
}

async function sendVideo(
  rawParams: unknown,
  reply: FastifyReply,
  dependencies: MvpRouteDependencies,
  download: boolean
) {
  const params = taskParamsSchema.safeParse(rawParams);
  if (!params.success) {
    return reply.code(400).send({ error: "INVALID_TASK_ID" });
  }
  const output = await dependencies.prisma.taskAsset.findFirst({
    where: {
      taskId: params.data.taskId,
      role: AssetRole.GENERATED_VIDEO
    },
    include: { asset: true }
  });
  if (output === null) {
    return reply.code(404).send({ error: "VIDEO_NOT_FOUND" });
  }

  reply.header("Content-Type", output.asset.mimeType);
  reply.header("Content-Length", output.asset.sizeBytes.toString());
  reply.header("Accept-Ranges", "none");
  if (download) {
    reply.header(
      "Content-Disposition",
      `attachment; filename="${params.data.taskId}.mp4"`
    );
  }
  return reply.send(
    dependencies.storage.openReadStream(output.asset.storageKey)
  );
}

function sanitizeFileName(fileName: string): string {
  const safeBaseName = basename(fileName)
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .slice(0, 120);
  return safeBaseName.length > 0
    ? safeBaseName
    : `reference${extname(fileName).slice(0, 10)}`;
}

const allowedImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

const imageExtensions: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp"
};
