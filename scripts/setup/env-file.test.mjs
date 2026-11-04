import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readDotenv } from "../deploy/required-secrets.mjs";
import { getValue, hasActiveKey, isBlank, parseEnvText, readEnvText, setValue } from "./env-file.mjs";

test("setValue replaces the first active line and keeps comments, order and unknown lines", () => {
  const text = "# top\nA=1\nWEIRD LINE\nB=old # note\nB=second\n";
  assert.equal(setValue(text, "B", "new"), "# top\nA=1\nWEIRD LINE\nB=new\nB=second\n");
});

test("setValue uncomments the first commented key, else appends", () => {
  assert.equal(setValue("# X=1\nA=1\n", "X", "2"), "X=2\nA=1\n");
  assert.equal(setValue("A=1", "X", "2"), "A=1\nX=2\n");
  assert.equal(setValue("A=1\n", "X", "2"), "A=1\nX=2\n");
});

test("setValue keeps CRLF line endings and export prefixes, and quotes awkward values", () => {
  assert.equal(setValue("export A=1\r\nB=2\r\n", "A", "9"), "export A=9\r\nB=2\r\n");
  const quoted = setValue("", "N", "two words");
  assert.equal(getValue(quoted, "N"), "two words");
  assert.throws(() => setValue("", "N", "a\nb"));
});

test("setValue does not match a key that only shares a prefix", () => {
  assert.equal(setValue("ABC=1\n", "AB", "2"), "ABC=1\nAB=2\n");
  assert.equal(hasActiveKey("ABC=1\n", "AB"), false);
  assert.equal(hasActiveKey("# AB=1\n", "AB"), false);
  assert.equal(hasActiveKey("AB=1\n", "AB"), true);
});

test("parseEnvText agrees with readDotenv", () => {
  const dir = mkdtempSync(join(tmpdir(), "env-file-"));
  const text = 'A=1\n# C=3\nexport B="two words"\nD=x # note\nE=\n';
  writeFileSync(join(dir, ".env"), text);
  assert.deepEqual(parseEnvText(text), readDotenv(join(dir, ".env")));
  assert.equal(readEnvText(join(dir, "missing")), "");
  assert.equal(isBlank(" "), true);
  assert.equal(isBlank("x"), false);
});
