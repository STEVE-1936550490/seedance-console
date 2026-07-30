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
  SeedanceProvider
} from "@seedance/seedance-provider";
import type {
  TaskDto,
  TaskListResponse,
  VideoGenerationJob
} from "@seedance/shared";
import type { Storage } from "@seedance/storage";

const createTaskSchema = z.object({
  clientRequestId: z.string().min(8).max(128),
  model: z.string().min(1).max(128),
  prompt: z.string().trim().min(1).max(5_000),
  assetIds: z.array(z.string().min(1)).max(8).default([]),
  parameters: z.record(z.string(), z.unknown())
});

const taskParamsSchema = z.object({ taskId: z.string().min(1) });

export interface MvpRouteDependencies {
  prisma: PrismaClient;
  provider: SeedanceProvider;
  taskQueue: Queue<VideoGenerationJob>;
  storage: Storage;
  uploadMaxBytes: number;
}

export async function registerMvpRoutes(
  server: FastifyInstance,
  dependencies: MvpRouteDependencies
): Promise<void> {
  await server.register(multipart, {
    limits: {
      files: 1,
      fileSize: dependencies.uploadMaxBytes
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
      return reply.code(400).send({ error: "IMAGE_REQUIRED" });
    }
    if (!allowedImageTypes.has(file.mimetype)) {
      return reply.code(415).send({ error: "UNSUPPORTED_IMAGE_TYPE" });
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
        sizeBytes: Number(asset.sizeBytes)
      });
    } catch (error) {
      await dependencies.storage.delete(storageKey).catch(() => undefined);
      throw error;
    }
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
                kind: AssetKind.INPUT_IMAGE
              }
            });
      if (assets.length !== new Set(parsed.data.assetIds).size) {
        return reply.code(400).send({ error: "INVALID_REFERENCE_ASSET" });
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
              role: AssetRole.REFERENCE_IMAGE,
              position
            }))
          }
        }
      });
      taskId = task.id;
    }

    await dependencies.taskQueue.add(
      "generate",
      { taskId },
      {
        jobId: taskId,
        attempts: 2,
        backoff: { type: "fixed", delay: 1_000 },
        removeOnComplete: 100,
        removeOnFail: 100
      }
    );

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
    .filter((relation) => relation.role === AssetRole.REFERENCE_IMAGE)
    .map((relation) => ({
      id: relation.asset.id,
      originalName: relation.asset.originalName,
      mimeType: relation.asset.mimeType
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
