import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

import type { StorageCandidate } from "./index.js";

export interface VideoInspectionPolicy {
  minDurationSeconds: number;
  maxDurationSeconds: number;
  ffprobePath?: string;
  timeoutMs?: number;
}

export interface VideoMetadata {
  durationSeconds: number;
  width: number;
  height: number;
  codec: string;
  pixelFormat: string | null;
  frameRate: string;
  hasAudio: boolean;
  container: "mp4";
}

export class VideoInspectionError extends Error {
  readonly code = "VIDEO_FILE_INVALID";

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "VideoInspectionError";
  }
}

export async function inspectMp4Video(
  candidate: StorageCandidate,
  policy: VideoInspectionPolicy
): Promise<VideoMetadata> {
  requirePositive(policy.minDurationSeconds, "Minimum video duration");
  requirePositive(policy.maxDurationSeconds, "Maximum video duration");
  if (policy.maxDurationSeconds < policy.minDurationSeconds) {
    throw new Error("Maximum video duration must not be below its minimum.");
  }
  const output = await runFfprobe(
    candidate,
    policy.ffprobePath ?? "ffprobe",
    policy.timeoutMs ?? 15_000
  );
  const parsed = parseProbeOutput(output);
  if (
    parsed.durationSeconds < policy.minDurationSeconds ||
    parsed.durationSeconds > policy.maxDurationSeconds
  ) {
    throw new VideoInspectionError(
      `Video duration must be between ${policy.minDurationSeconds} and ${policy.maxDurationSeconds} seconds.`
    );
  }
  return parsed;
}

async function runFfprobe(
  candidate: StorageCandidate,
  executable: string,
  timeoutMs: number
): Promise<string> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("ffprobe timeout must be a positive safe integer.");
  }
  const temporaryRoot = await mkdtemp(join(tmpdir(), "seedance-ffprobe-"));
  const temporaryVideo = join(temporaryRoot, "candidate.mp4");
  let source: ReturnType<StorageCandidate["openReadStream"]> | undefined;
  try {
    source = candidate.openReadStream();
    await pipeline(
      source,
      createWriteStream(temporaryVideo, { flags: "wx", mode: 0o600 })
    );
    return await runFfprobeFile(temporaryVideo, executable, timeoutMs);
  } catch (error) {
    if (error instanceof VideoInspectionError) throw error;
    throw new VideoInspectionError("ffprobe execution failed.", {
      cause: error
    });
  } finally {
    source?.destroy();
    await removeIfPresent(temporaryVideo);
    await rmdir(temporaryRoot);
  }
}

async function runFfprobeFile(
  path: string,
  executable: string,
  timeoutMs: number
): Promise<string> {
  const child = spawn(
    executable,
    [
      "-v",
      "error",
      "-show_entries",
      "format=format_name,duration:stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,pix_fmt",
      "-of",
      "json",
      path
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let errorBytes = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  timer.unref();
  child.stdout.on("data", (chunk: Buffer) => {
    outputBytes += chunk.byteLength;
    if (outputBytes <= 256 * 1024) stdout.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    errorBytes += chunk.byteLength;
    if (errorBytes <= 8 * 1024) stderr.push(chunk);
  });
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (value) => resolve(value ?? -1));
    });
    if (timedOut) throw new VideoInspectionError("ffprobe timed out.");
    if (code !== 0 || outputBytes > 256 * 1024) {
      const diagnostic = Buffer.concat(stderr).toString("utf8").trim();
      throw new VideoInspectionError(
        diagnostic.length > 0
          ? "ffprobe rejected the video container."
          : "ffprobe could not inspect the video."
      );
    }
    return Buffer.concat(stdout).toString("utf8");
  } catch (error) {
    if (error instanceof VideoInspectionError) throw error;
    throw new VideoInspectionError("ffprobe execution failed.", {
      cause: error
    });
  } finally {
    clearTimeout(timer);
  }
}

function parseProbeOutput(value: string): VideoMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new VideoInspectionError("ffprobe returned invalid JSON.", {
      cause: error
    });
  }
  if (!isRecord(parsed) || !isRecord(parsed.format)) {
    throw new VideoInspectionError("ffprobe returned no video format.");
  }
  const formatNames = String(parsed.format.format_name ?? "").split(",");
  if (!formatNames.includes("mp4")) {
    throw new VideoInspectionError("Video container is not MP4.");
  }
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const videoStreams = streams.filter(
    (stream): stream is Record<string, unknown> =>
      isRecord(stream) && stream.codec_type === "video"
  );
  if (videoStreams.length !== 1) {
    throw new VideoInspectionError(
      "Video must contain exactly one video stream."
    );
  }
  const video = videoStreams[0]!;
  const durationSeconds = Number(parsed.format.duration);
  const width = Number(video.width);
  const height = Number(video.height);
  const codec = typeof video.codec_name === "string" ? video.codec_name : "";
  const frameRate =
    typeof video.avg_frame_rate === "string" && video.avg_frame_rate !== "0/0"
      ? video.avg_frame_rate
      : typeof video.r_frame_rate === "string"
        ? video.r_frame_rate
        : "";
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    !Number.isSafeInteger(height) ||
    height <= 0 ||
    codec.length === 0 ||
    frameRate.length === 0 ||
    !/^\d+\/\d+$/.test(frameRate)
  ) {
    throw new VideoInspectionError("Video metadata is incomplete.");
  }
  return {
    durationSeconds,
    width,
    height,
    codec,
    pixelFormat: typeof video.pix_fmt === "string" ? video.pix_fmt : null,
    frameRate,
    hasAudio: streams.some(
      (stream) => isRecord(stream) && stream.codec_type === "audio"
    ),
    container: "mp4"
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requirePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be positive.`);
  }
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
