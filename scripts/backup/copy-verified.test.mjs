import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { copyVerified, fileSha256 } from "./copy-verified.mjs";

function scratch() {
  return mkdtempSync(join(tmpdir(), "copy-verified-"));
}

test("copies the backup under its final name with identical bytes and no .partial left", async () => {
  const root = scratch();
  try {
    const source = join(root, "priorities-a.json");
    writeFileSync(source, '{"x":1}\n');
    const destination = await copyVerified(source, join(root, "share"));
    assert.equal(readFileSync(destination, "utf8"), '{"x":1}\n');
    assert.deepEqual(readdirSync(join(root, "share")), ["priorities-a.json"]);
    assert.equal(await fileSha256(source), await fileSha256(destination));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed copy leaves no file matching the backup name or a .partial", async () => {
  const root = scratch();
  try {
    const share = join(root, "share");
    mkdirSync(join(share, "priorities-b.json"), { recursive: true });
    writeFileSync(join(share, "priorities-b.json", "x"), "x");
    const source = join(root, "priorities-b.json");
    writeFileSync(source, "{}");
    await assert.rejects(copyVerified(source, share));
    assert.deepEqual(readdirSync(share), ["priorities-b.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
