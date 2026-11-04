import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { missingBlobHashes, referencedBlobHashes } from "./photo-blobs";

const a = "a".repeat(64);
const b = "b".repeat(64);
const c = "c".repeat(64);
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "photo-blobs-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("referencedBlobHashes", () => {
  it("collects originals, working copies and place photos once each, ignoring nulls", () => {
    expect(
      referencedBlobHashes({
        photo_checkin: [
          { original_hash: a, working_hash: b },
          { original_hash: a, working_hash: null }
        ],
        place_reference_photo: [{ blob_hash: c }, { blob_hash: a }]
      })
    ).toEqual([a, b, c]);
    expect(referencedBlobHashes({})).toEqual([]);
  });
});

describe("missingBlobHashes", () => {
  it("names the hashes with no file, and never joins a non-hash into a path", async () => {
    await mkdir(join(dir, "aa"), { recursive: true });
    await writeFile(join(dir, "aa", a), "x");
    expect(await missingBlobHashes(dir, [a, b, "../../etc/passwd"])).toEqual([b, "../../etc/passwd"]);
    expect(await missingBlobHashes(join(dir, "nowhere"), [a])).toEqual([a]);
  });
});
