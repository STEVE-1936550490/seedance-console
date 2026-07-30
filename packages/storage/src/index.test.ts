import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { LocalStorage } from "./index.js";

describe("LocalStorage", () => {
  it("rejects path traversal before touching the filesystem", async () => {
    const storage = new LocalStorage("/tmp/seedance-storage-test");
    await expect(
      storage.put("../outside.txt", Readable.from("unsafe"))
    ).rejects.toThrow("escapes");
  });
});
