import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");

try {
  process.loadEnvFile(resolve(repositoryRoot, ".env"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const forbiddenNames = ["MAAS_API_KEY", "MAAS_PRIVATE_KEY_PATH"];
const configuredSecret = process.env.MAAS_API_KEY?.trim();
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
    if (
      configuredSecret !== undefined &&
      configuredSecret.length >= 8 &&
      content.includes(configuredSecret)
    ) {
      throw new Error("Client output contains the configured API key.");
    }
  }
}

for (const deploymentFile of ["Dockerfile", "docker-compose.yml"]) {
  const path = resolve(repositoryRoot, deploymentFile);
  const content = await readFile(path, "utf8");

  for (const name of forbiddenNames) {
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
