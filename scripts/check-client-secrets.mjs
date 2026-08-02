import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");

try {
  process.loadEnvFile(resolve(repositoryRoot, ".env"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const forbiddenNames = [
  "SEEDANCE_API_KEY",
  "SEEDANCE_BASE_URL",
  "SEEDANCE_BRIDGE_TOKEN",
  "SEEDANCE_BRIDGE_URL",
  "SEEDANCE_ASSET_SIGNING_KEY",
  "SEEDANCE_ASSET_PUBLIC_BASE_URL",
  "SEEDANCE_ASSET_URL_TTL_MS",
  "SEEDANCE_ASSET_MAX_BYTES",
  "EOS_ENDPOINT",
  "EOS_REGION",
  "EOS_BUCKET",
  "EOS_ACCESS_KEY_ID",
  "EOS_SECRET_ACCESS_KEY",
  "AICC_API_KEY",
  "AICC_BASE_URL",
  "MAAS_API_KEY",
  "MAAS_BASE_URL",
  "MAAS_PRIVATE_KEY_PATH"
];
const forbiddenDeploymentNames = [
  "SEEDANCE_API_KEY",
  "SEEDANCE_BASE_URL",
  "MAAS_API_KEY",
  "MAAS_PRIVATE_KEY_PATH"
];
const configuredSecrets = [
  process.env.SEEDANCE_API_KEY?.trim(),
  process.env.SEEDANCE_BRIDGE_TOKEN?.trim(),
  process.env.SEEDANCE_ASSET_SIGNING_KEY?.trim(),
  process.env.EOS_ACCESS_KEY_ID?.trim(),
  process.env.EOS_SECRET_ACCESS_KEY?.trim(),
  process.env.AICC_API_KEY?.trim(),
  process.env.MAAS_API_KEY?.trim()
].filter((value) => value !== undefined && value.length >= 8);
const forbiddenUrlFragments = [
  "X-Amz-Credential=",
  "X-Amz-Signature=",
  "X-Tos-Signature=",
  "X-Tos-Credential="
];
const roots = [
  resolve(repositoryRoot, "apps/web/src"),
  resolve(repositoryRoot, "apps/web/.next")
];

for (const root of roots) {
  for (const path of await collectFiles(root)) {
    const content = await readFile(path, "utf8").catch(() => "");
    for (const name of forbiddenNames) {
      if (content.includes(name)) {
        throw new Error(
          `Client output contains forbidden server variable: ${name}`
        );
      }
    }
    for (const configuredSecret of configuredSecrets) {
      if (content.includes(configuredSecret)) {
        throw new Error("Client output contains a configured server secret.");
      }
    }
    for (const fragment of forbiddenUrlFragments) {
      if (content.includes(fragment)) {
        throw new Error("Client output contains a presigned URL fragment.");
      }
    }
  }
}

for (const deploymentFile of ["Dockerfile", "docker-compose.yml"]) {
  const path = resolve(repositoryRoot, deploymentFile);
  const content = await readFile(path, "utf8");

  for (const name of forbiddenDeploymentNames) {
    if (content.includes(name)) {
      throw new Error(`${name} must not be injected by ${deploymentFile}.`);
    }
  }
}

console.log("Client secret scan passed.");

async function collectFiles(root) {
  const result = [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await collectFiles(path)));
    } else if (entry.isFile()) {
      result.push(path);
    }
  }
  return result;
}
