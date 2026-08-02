import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import {
  AssetPublishingError,
  SignedAssetPublisher,
  type PublishableAssetRecord
} from "./asset-publisher.js";
import { LocalStorage } from "./index.js";

const signingKey = "fixture-signing-key-with-at-least-32-bytes";
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.from("fixture-png")
]);

describe("SignedAssetPublisher", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots
        .splice(0)
        .map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  async function fixture(overrides: Partial<PublishableAssetRecord> = {}) {
    const root = await mkdtemp(join(tmpdir(), "seedance-assets-"));
    temporaryRoots.push(root);
    const storage = new LocalStorage(root);
    await storage.put("inputs/image.png", Readable.from(png));
    const records = new Map<string, PublishableAssetRecord>();
    records.set("asset-one", {
      id: "asset-one",
      kind: "INPUT_IMAGE",
      storageKey: "inputs/image.png",
      mimeType: "image/png",
      sizeBytes: png.byteLength,
      checksum: createHash("sha256").update(png).digest("hex"),
      ...overrides
    });
    let currentTime = Date.parse("2026-07-31T12:00:00.000Z");
    const publisher = new SignedAssetPublisher({
      signingKey,
      publicBaseUrl: "https://assets.example.com",
      urlTtlMs: 120_000,
      maxBytes: 1_024,
      storage,
      loadAsset: async (assetId) => records.get(assetId) ?? null,
      now: () => new Date(currentTime)
    });
    return {
      publisher,
      records,
      storage,
      expire: () => {
        currentTime += 120_001;
      }
    };
  }

  it("publishes and authorizes a bound short-lived HTTPS URL", async () => {
    const { publisher } = await fixture();
    const published = await publisher.publishForProvider({
      assetId: "asset-one",
      provider: "seedance",
      purpose: "reference-image",
      minimumTtlMs: 90_000
    });
    const url = new URL(published.url);

    expect(url.origin).toBe("https://assets.example.com");
    expect(published).toMatchObject({
      assetId: "asset-one",
      role: "REFERENCE_IMAGE",
      mimeType: "image/png",
      sizeBytes: png.byteLength
    });
    await expect(
      publisher.authorizeProviderAsset({
        assetId: "asset-one",
        provider: url.searchParams.get("provider")!,
        purpose: url.searchParams.get("purpose")!,
        expires: url.searchParams.get("expires")!,
        signature: url.searchParams.get("signature")!
      })
    ).resolves.toMatchObject({ storageKey: "inputs/image.png" });
  });

  it.each([
    ["assetId", "asset-two"],
    ["provider", "other"],
    ["purpose", "other-purpose"],
    ["expires", "1785500000000"],
    ["signature", "invalid"],
    ["signature", "a".repeat(44)]
  ])("rejects a changed %s", async (field, replacement) => {
    const { publisher } = await fixture();
    const published = await publisher.publishForProvider({
      assetId: "asset-one",
      provider: "seedance",
      purpose: "reference-image",
      minimumTtlMs: 1
    });
    const url = new URL(published.url);
    const input = {
      assetId: "asset-one",
      provider: url.searchParams.get("provider")!,
      purpose: url.searchParams.get("purpose")!,
      expires: url.searchParams.get("expires")!,
      signature: url.searchParams.get("signature")!,
      [field]: replacement
    };
    await expectCode(
      publisher.authorizeProviderAsset(input),
      field === "provider" || field === "purpose"
        ? "ASSET_PUBLISHING_INVALID_REQUEST"
        : "ASSET_SIGNATURE_INVALID"
    );
  });

  it("rejects expiration and a deleted database record", async () => {
    const { publisher, records, expire } = await fixture();
    const published = await publisher.publishForProvider({
      assetId: "asset-one",
      provider: "seedance",
      purpose: "reference-image",
      minimumTtlMs: 1
    });
    const url = new URL(published.url);
    const input = {
      assetId: "asset-one",
      provider: "seedance",
      purpose: "reference-image",
      expires: url.searchParams.get("expires")!,
      signature: url.searchParams.get("signature")!
    };
    records.delete("asset-one");
    await expectCode(
      publisher.authorizeProviderAsset(input),
      "ASSET_NOT_FOUND"
    );
    records.set("asset-one", {
      id: "asset-one",
      kind: "INPUT_IMAGE",
      storageKey: "inputs/image.png",
      mimeType: "image/png",
      sizeBytes: png.byteLength,
      checksum: createHash("sha256").update(png).digest("hex")
    });
    expire();
    await expectCode(
      publisher.authorizeProviderAsset(input),
      "ASSET_URL_EXPIRED"
    );
  });

  it.each([
    [{ mimeType: "image/webp" }, "ASSET_TYPE_UNSUPPORTED"],
    [{ sizeBytes: 0 }, "ASSET_EMPTY"],
    [{ sizeBytes: 2_000 }, "ASSET_TOO_LARGE"],
    [{ checksum: "0".repeat(64) }, "ASSET_METADATA_MISMATCH"],
    [{ storageKey: "inputs/missing.png" }, "ASSET_FILE_MISSING"],
    [{ storageKey: "../../etc/passwd" }, "ASSET_FILE_INVALID"]
  ] as const)("rejects unsafe metadata %#", async (overrides, code) => {
    const { publisher } = await fixture(overrides);
    await expectCode(
      publisher.publishForProvider({
        assetId: "asset-one",
        provider: "seedance",
        purpose: "reference-image",
        minimumTtlMs: 1
      }),
      code
    );
  });

  it("rejects MIME metadata that does not match the file", async () => {
    const { publisher } = await fixture({ mimeType: "image/jpeg" });
    await expectCode(
      publisher.publishForProvider({
        assetId: "asset-one",
        provider: "seedance",
        purpose: "reference-image",
        minimumTtlMs: 1
      }),
      "ASSET_METADATA_MISMATCH"
    );
  });

  it.each([
    "http://assets.example.com",
    "https://localhost",
    "https://api.local",
    "https://127.0.0.1",
    "https://10.0.0.1"
  ])("fails closed for a non-public base URL: %s", (publicBaseUrl) => {
    expect(
      () =>
        new SignedAssetPublisher({
          signingKey,
          publicBaseUrl,
          urlTtlMs: 60_000,
          maxBytes: 1_024,
          storage: new LocalStorage("/tmp/unused-seedance-assets"),
          loadAsset: async () => null
        })
    ).toThrowError(AssetPublishingError);
  });
});

async function expectCode(
  promise: Promise<unknown>,
  code: string
): Promise<void> {
  try {
    await promise;
    throw new Error("Expected AssetPublishingError.");
  } catch (error) {
    expect(error).toBeInstanceOf(AssetPublishingError);
    expect((error as AssetPublishingError).code).toBe(code);
  }
}
