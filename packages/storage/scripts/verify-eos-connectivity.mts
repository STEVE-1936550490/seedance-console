import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
};
const endpoint = required("EOS_ENDPOINT");
if (new URL(endpoint).protocol !== "https:") {
  throw new Error("EOS_ENDPOINT must use HTTPS.");
}
const region = required("EOS_REGION");
const bucket = required("EOS_BUCKET");
const accessKeyId = required("EOS_ACCESS_KEY_ID");
const secretAccessKey = required("EOS_SECRET_ACCESS_KEY");
const forcePathStyle = process.env.EOS_FORCE_PATH_STYLE === "true";
const prefix = (
  process.env.EOS_OBJECT_PREFIX?.trim() || "seedance-inputs/"
).replace(/\/*$/, "/");
if (prefix.startsWith("/") || prefix.includes("..") || prefix.includes("\\")) {
  throw new Error("EOS_OBJECT_PREFIX is invalid.");
}

const fixtureBase64 = await readFile(
  new URL("../fixtures/eos-connectivity.png.base64", import.meta.url),
  "utf8"
);
const fixture = Buffer.from(fixtureBase64.trim(), "base64");
const expectedSha256 = createHash("sha256").update(fixture).digest("hex");
const objectKey = `${prefix}connectivity/${randomBytes(24).toString("hex")}`;
const client = new S3Client({
  endpoint,
  region,
  forcePathStyle,
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
  credentials: { accessKeyId, secretAccessKey }
});

let uploaded = false;
let checksComplete = false;
let presignedUrl: string | undefined;
let deletionVerified = false;
let operationError: unknown;
try {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      Body: fixture,
      ContentLength: fixture.byteLength,
      ContentType: "image/png"
    })
  );
  uploaded = true;
  presignedUrl = await getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: bucket, Key: objectKey }),
    { expiresIn: 300 }
  );
  const response = await fetch(presignedUrl, { redirect: "error" });
  if (!response.ok)
    throw new Error(`Presigned GET returned HTTP ${response.status}.`);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0];
  if (contentType !== "image/png") {
    throw new Error(
      `Presigned GET returned unexpected Content-Type ${contentType ?? "missing"}.`
    );
  }
  const downloaded = Buffer.from(await response.arrayBuffer());
  const actualSha256 = createHash("sha256").update(downloaded).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error("Presigned GET SHA-256 does not match the fixture.");
  }
  checksComplete = true;
} catch (error) {
  operationError = error;
}

let cleanupError: unknown;
try {
  if (uploaded) {
    await client.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: objectKey })
    );
    if (checksComplete && presignedUrl !== undefined) {
      const deletedResponse = await fetch(presignedUrl, {
        redirect: "error"
      });
      if (deletedResponse.status !== 404) {
        throw new Error(
          `Deleted object verification returned HTTP ${deletedResponse.status}.`
        );
      }
      deletionVerified = true;
    }
  }
} catch (error) {
  cleanupError = error;
} finally {
  client.destroy();
}

if (operationError !== undefined) throw operationError;
if (cleanupError !== undefined) throw cleanupError;

if (checksComplete && deletionVerified) {
  console.log(
    JSON.stringify({
      ok: true,
      bucket,
      objectKey: `${objectKey.slice(0, Math.min(prefix.length + 8, objectKey.length))}…`,
      sizeBytes: fixture.byteLength,
      sha256Prefix: expectedSha256.slice(0, 12),
      expiresInSeconds: 300,
      deleted: true,
      deletedGetStatus: 404
    })
  );
}
