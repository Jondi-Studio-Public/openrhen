import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertBackupTarget, TARGET_SENTINEL } from "./target-guard.mjs";

const GB = 1024 ** 3;
const space = (freeGb, totalGb) => async () => ({
  bsize: 1024,
  bavail: (freeGb * GB) / 1024,
  blocks: (totalGb * GB) / 1024
});

function withDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "target-guard-"));
  return Promise.resolve(run(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("refuses a directory without the sentinel file", () =>
  withDir(async (dir) => {
    await assert.rejects(assertBackupTarget(dir, { statfsImpl: space(500, 1000) }), /not mounted/);
  }));

test("accepts a sentinel directory with enough free space", () =>
  withDir(async (dir) => {
    writeFileSync(join(dir, TARGET_SENTINEL), "");
    const result = await assertBackupTarget(dir, { statfsImpl: space(500, 1000) });
    assert.equal(result.neededBytes, 5 * GB);
  }));

test("accepts a nearly full pool while enough GB remain", () =>
  withDir(async (dir) => {
    writeFileSync(join(dir, TARGET_SENTINEL), "");
    await assertBackupTarget(dir, { statfsImpl: space(50, 1000) });
  }));

test("needs three times a large backup's size", () =>
  withDir(async (dir) => {
    writeFileSync(join(dir, TARGET_SENTINEL), "");
    await assert.rejects(assertBackupTarget(dir, { backupBytes: 4 * GB, statfsImpl: space(10, 1000) }), /12\.0 GB/);
  }));

test("refuses under 5 GB free", () =>
  withDir(async (dir) => {
    writeFileSync(join(dir, TARGET_SENTINEL), "");
    await assert.rejects(assertBackupTarget(dir, { statfsImpl: space(4, 10) }), /free/);
  }));
