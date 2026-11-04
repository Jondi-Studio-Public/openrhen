import assert from "node:assert/strict";
import { test } from "node:test";
import { fallbackMigrateMode, migrateModeMessage } from "./migrate-mode.mjs";

const clean = { migrateFlag: false, treeClean: true, atOriginMain: true };

test("a clean tree at origin/main applies", () => {
  assert.equal(fallbackMigrateMode(clean).value, "apply");
  assert.equal(fallbackMigrateMode({ ...clean, configured: "  " }).value, "apply");
});

test("a dirty tree, or one not at origin/main, skips", () => {
  assert.equal(fallbackMigrateMode({ ...clean, treeClean: false }).value, "skip");
  assert.equal(fallbackMigrateMode({ ...clean, atOriginMain: false }).value, "skip");
  assert.match(fallbackMigrateMode({ ...clean, treeClean: false }).reason, /uncommitted|--dirty/);
  assert.match(fallbackMigrateMode({ ...clean, atOriginMain: false }).reason, /origin\/main/);
});

test("--migrate applies from any tree", () => {
  const result = fallbackMigrateMode({ migrateFlag: true, treeClean: false, atOriginMain: false });
  assert.deepEqual(result, { value: "apply", reason: "--migrate was passed" });
});

test("an explicit skip beats everything, --migrate included", () => {
  assert.equal(fallbackMigrateMode({ ...clean, configured: "skip", migrateFlag: true }).value, "skip");
  assert.equal(fallbackMigrateMode({ ...clean, configured: " SKIP " }).value, "skip");
});

test("an apply in the shell or .env does not unlock a dirty tree", () => {
  assert.equal(fallbackMigrateMode({ ...clean, configured: "apply", treeClean: false }).value, "skip");
  assert.equal(fallbackMigrateMode({ ...clean, configured: "apply" }).value, "apply");
});

test("an unknown value is passed through so the migrate service rejects it", () => {
  assert.equal(fallbackMigrateMode({ ...clean, configured: "yes" }).value, "yes");
});

test("a skip prints one line saying migrations were not applied and why", () => {
  const line = migrateModeMessage(fallbackMigrateMode({ ...clean, treeClean: false }));
  assert.ok(!line.includes("\n"));
  assert.match(line, /^Migrations NOT applied: .*--migrate/);
  assert.match(migrateModeMessage({ value: "apply", reason: "x" }), /^Migrations: will be applied/);
});
