import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listBlobs, syncBlobs } from "./photo-sync.mjs";

const hashA = "ab".repeat(32);
const hashB = "cd".repeat(32);

function blobStore() {
  const root = mkdtempSync(join(tmpdir(), "photo-sync-"));
  const put = (dir, hash, text) => {
    mkdirSync(join(dir, hash.slice(0, 2)), { recursive: true });
    writeFileSync(join(dir, hash.slice(0, 2), hash), text);
  };
  return { root, put };
}

test("copies the blobs the destination lacks and leaves the ones it has untouched", async () => {
  const { root, put } = blobStore();
  const source = join(root, "source");
  const destination = join(root, "copy");
  put(source, hashA, "photo A");
  put(source, hashB, "photo B");
  put(destination, hashA, "photo Z");
  const result = await syncBlobs(source, destination);
  assert.deepEqual(result, { copied: 1, present: 1, mismatched: [] });
  assert.equal(readFileSync(join(destination, hashA.slice(0, 2), hashA), "utf8"), "photo Z");
  assert.equal(readFileSync(join(destination, hashB.slice(0, 2), hashB), "utf8"), "photo B");
  rmSync(root, { recursive: true, force: true });
});

test("never deletes: a blob removed from the source stays in the copy", async () => {
  const { root, put } = blobStore();
  put(join(root, "copy"), hashA, "kept");
  await syncBlobs(join(root, "source"), join(root, "copy"));
  assert.ok(existsSync(join(root, "copy", hashA.slice(0, 2), hashA)));
  rmSync(root, { recursive: true, force: true });
});

test("skips temporary and stray files, and a missing source folder is not an error", async () => {
  const { root, put } = blobStore();
  const source = join(root, "source");
  put(source, hashA, "real");
  writeFileSync(join(source, hashA.slice(0, 2), `${hashA}.1234.tmp`), "half written");
  writeFileSync(join(source, "notes.txt"), "stray");
  assert.deepEqual(
    (await listBlobs(source)).map((blob) => blob.hash),
    [hashA]
  );
  assert.deepEqual(await listBlobs(join(root, "absent")), []);
  rmSync(root, { recursive: true, force: true });
});

test("a truncated file already under a real hash is reported, not trusted or overwritten", async () => {
  const { root, put } = blobStore();
  put(join(root, "source"), hashA, "the whole photo");
  put(join(root, "copy"), hashA, "the who");
  const result = await syncBlobs(join(root, "source"), join(root, "copy"));
  assert.deepEqual(result, { copied: 0, present: 0, mismatched: [hashA] });
  assert.equal(readFileSync(join(root, "copy", hashA.slice(0, 2), hashA), "utf8"), "the who");
  rmSync(root, { recursive: true, force: true });
});

test("a copy leaves no temporary file behind", async () => {
  const { root, put } = blobStore();
  put(join(root, "source"), hashA, "photo");
  await syncBlobs(join(root, "source"), join(root, "copy"));
  assert.deepEqual(readdirSync(join(root, "copy", hashA.slice(0, 2))), [hashA]);
  rmSync(root, { recursive: true, force: true });
});
