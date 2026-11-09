import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readCaseFiles } from "./replay-case-files.mjs";

test("no files for an unset or missing directory", () => {
  assert.deepEqual(readCaseFiles(undefined), []);
  assert.deepEqual(readCaseFiles(join(tmpdir(), "replay-no-such-directory")), []);
});

test("reads only json files, sorted, from a directory outside a checkout", () => {
  const dir = mkdtempSync(join(tmpdir(), "replay-ext-"));
  writeFileSync(join(dir, "b.json"), "[]");
  writeFileSync(join(dir, "a.json"), "{}");
  writeFileSync(join(dir, "notes.txt"), "x");
  assert.deepEqual(readCaseFiles(dir), [
    { name: "a.json", text: "{}" },
    { name: "b.json", text: "[]" }
  ]);
});

test("refuses a directory inside a git checkout", () => {
  assert.throws(() => readCaseFiles(import.meta.dirname), /outside any git checkout/);
});

test("refuses a symlink to a directory inside a git checkout", () => {
  const base = mkdtempSync(join(tmpdir(), "replay-link-"));
  const link = join(base, "cases");
  symlinkSync(import.meta.dirname, link, "dir");
  assert.throws(() => readCaseFiles(link), /outside any git checkout/);
});

test("refuses a symlinked file that points into a git checkout", () => {
  const dir = mkdtempSync(join(tmpdir(), "replay-filelink-"));
  writeFileSync(join(dir, "ok.json"), "{}");
  symlinkSync(join(import.meta.dirname, "replay-case-files.mjs"), join(dir, "inside.json"));
  assert.throws(() => readCaseFiles(dir), /outside any git checkout \(file inside\.json\)/);
});

test("reads through a symlinked directory that points outside a checkout", () => {
  const dir = mkdtempSync(join(tmpdir(), "replay-real-"));
  writeFileSync(join(dir, "a.json"), "{}");
  const link = join(mkdtempSync(join(tmpdir(), "replay-link2-")), "cases");
  symlinkSync(dir, link, "dir");
  assert.deepEqual(readCaseFiles(link), [{ name: "a.json", text: "{}" }]);
});
