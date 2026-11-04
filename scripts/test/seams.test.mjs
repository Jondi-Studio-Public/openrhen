import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// scripts/repository/seams.json is core's own list of the stub files an add-on may replace. The add-on layer
// reads it (it cannot rely on the private repository's export tooling, which retires), so it must match the tree.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const listed = JSON.parse(readFileSync(resolve(root, "scripts/repository/seams.json"), "utf8")).stubs;

test("every listed stub exists and sits under a private folder", () => {
  assert.ok(listed.length > 0);
  for (const path of listed) {
    assert.ok(existsSync(resolve(root, path)), `${path} is listed but missing`);
    assert.match(path, /(?:^|\/)private\//, `${path} is not under a private/ folder`);
  }
});

test("the list is sorted and has no duplicates", () => {
  assert.deepEqual(listed, [...new Set(listed)].sort());
});

// A composed tree (core plus an add-on) records the add-on's files in .sync-core.json as `overlayFiles`. The add-on
// fills the stubs and may add more files under private/ folders; those are its own, not stubs. Stock core has no such
// file, so there every file under a private folder must be a listed stub.
const composedFile = resolve(root, ".sync-core.json");
const addonOwned = new Set(
  existsSync(composedFile) ? (JSON.parse(readFileSync(composedFile, "utf8")).overlayFiles ?? []) : []
);

test("every tracked file under a private folder is listed", () => {
  const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n")
    // The example add-on's overlay mirrors core's layout, so its stub copies are not core stubs.
    .filter(
      (file) =>
        /(?:^|\/)private\//.test(file) &&
        !file.startsWith("integrations/addon-example/overlay/") &&
        existsSync(resolve(root, file)) &&
        (!addonOwned.has(file) || listed.includes(file))
    );
  assert.deepEqual(tracked.sort(), [...listed]);
});

test("a composed tree lists only files that exist, and every listed stub is still core's or the add-on's", () => {
  for (const file of addonOwned)
    assert.ok(existsSync(resolve(root, file)), `${file} is recorded as the add-on's but missing`);
});
