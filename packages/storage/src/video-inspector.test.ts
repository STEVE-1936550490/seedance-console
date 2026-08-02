import { createReadStream } from "node:fs";

import { describe, expect, it } from "vitest";

import type { StorageCandidate } from "./index.js";
import { inspectMp4Video, VideoInspectionError } from "./video-inspector.js";

const fixtureUrl = new URL(
  "../../seedance-provider/fixtures/mock-output.mp4",
  import.meta.url
);

const fixtureCandidate: StorageCandidate = {
  sizeBytes: 11_980,
  sha256: "fixture",
  openReadStream: () => createReadStream(fixtureUrl)
};

describe("inspectMp4Video", () => {
  it("accepts a valid MP4 and records non-contract media metadata", async () => {
    await expect(
      inspectMp4Video(fixtureCandidate, {
        minDurationSeconds: 2,
        maxDurationSeconds: 15
      })
    ).resolves.toMatchObject({
      container: "mp4",
      durationSeconds: 3,
      width: 1280,
      height: 720,
      codec: "h264",
      pixelFormat: "yuv420p",
      frameRate: "24/1",
      hasAudio: false
    });
  });

  it("rejects videos below the configured minimum duration", async () => {
    await expect(
      inspectMp4Video(fixtureCandidate, {
        minDurationSeconds: 3.1,
        maxDurationSeconds: 15
      })
    ).rejects.toBeInstanceOf(VideoInspectionError);
  });

  it("rejects videos above the configured maximum duration", async () => {
    await expect(
      inspectMp4Video(fixtureCandidate, {
        minDurationSeconds: 2,
        maxDurationSeconds: 2.9
      })
    ).rejects.toBeInstanceOf(VideoInspectionError);
  });

  it("rejects damaged video bytes", async () => {
    await expect(
      inspectMp4Video(
        {
          sizeBytes: 16,
          sha256: "fixture",
          openReadStream: () =>
            createReadStream(new URL("./index.ts", import.meta.url))
        },
        { minDurationSeconds: 2, maxDurationSeconds: 15 }
      )
    ).rejects.toBeInstanceOf(VideoInspectionError);
  });

  it("fails closed when ffprobe cannot execute", async () => {
    await expect(
      inspectMp4Video(fixtureCandidate, {
        minDurationSeconds: 2,
        maxDurationSeconds: 15,
        ffprobePath: "/missing/seedance-ffprobe"
      })
    ).rejects.toBeInstanceOf(VideoInspectionError);
  });
});
