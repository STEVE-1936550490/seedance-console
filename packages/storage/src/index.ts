import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat, unlink } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";

export interface StoredObjectInfo {
  sizeBytes: number;
}

export interface Storage {
  put(storageKey: string, source: Readable): Promise<StoredObjectInfo>;
  openReadStream(storageKey: string): Readable;
  stat(storageKey: string): Promise<StoredObjectInfo>;
  delete(storageKey: string): Promise<void>;
}

export class LocalStorage implements Storage {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async put(storageKey: string, source: Readable): Promise<StoredObjectInfo> {
    const target = this.resolveKey(storageKey);
    await mkdir(dirname(target), { recursive: true });
    await pipeline(source, createWriteStream(target, { flags: "wx" }));
    return this.stat(storageKey);
  }

  openReadStream(storageKey: string): Readable {
    return createReadStream(this.resolveKey(storageKey));
  }

  async stat(storageKey: string): Promise<StoredObjectInfo> {
    const info = await stat(this.resolveKey(storageKey));
    return { sizeBytes: info.size };
  }

  async delete(storageKey: string): Promise<void> {
    await unlink(this.resolveKey(storageKey));
  }

  private resolveKey(storageKey: string): string {
    if (
      storageKey.length === 0 ||
      storageKey.includes("\0") ||
      storageKey.startsWith("/")
    ) {
      throw new Error("Invalid storage key.");
    }
    const target = resolve(this.root, storageKey);
    if (target !== this.root && !target.startsWith(`${this.root}${sep}`)) {
      throw new Error("Storage key escapes the configured root.");
    }
    return target;
  }
}
