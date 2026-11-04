import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { blobPath, getBlob, hashBytes, putBlob } from "./photo-store";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "photo-store-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const photo = Uint8Array.from([0xff, 0xd8, 0xff, 1, 2, 3]);

describe("the photo blob store", () => {
  it("names a file by the hash of its bytes and reads it back", async () => {
    const hash = await putBlob(dir, photo);
    expect(hash).toBe(hashBytes(photo));
    expect(blobPath(dir, hash)).toBe(join(dir, hash.slice(0, 2), hash));
    expect(new Uint8Array((await getBlob(dir, hash))!)).toEqual(photo);
  });

  it("writes the same bytes once and leaves no temporary file behind", async () => {
    const hash = await putBlob(dir, photo);
    await putBlob(dir, photo);
    expect(await readdir(join(dir, hash.slice(0, 2)))).toEqual([hash]);
  });

  it("reports a missing blob as null, as after a restore without the folder", async () => {
    expect(await getBlob(dir, hashBytes(Uint8Array.from([9])))).toBeNull();
  });

  it("does not serve a file whose bytes no longer match its name", async () => {
    const hash = await putBlob(dir, photo);
    await writeFile(blobPath(dir, hash), "tampered");
    expect(await getBlob(dir, hash)).toBeNull();
    expect(await readFile(blobPath(dir, hash), "utf8")).toBe("tampered");
  });

  it("refuses a hash that could name a path outside the store", () => {
    expect(() => blobPath(dir, "../../etc/passwd")).toThrow();
    expect(() => blobPath(dir, "abc")).toThrow();
  });
});
