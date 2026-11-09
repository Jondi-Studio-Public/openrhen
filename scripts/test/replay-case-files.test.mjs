import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
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
