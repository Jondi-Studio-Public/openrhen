import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readDotenv } from "../deploy/required-secrets.mjs";
import { applyAddonEnv, findFragments, parseFragment } from "./addon-env.mjs";
import { makeRoot } from "./fixture.mjs";
import { initEnv } from "./init-env.mjs";

const fragment = (cwd, id, text) => {
  mkdirSync(join(cwd, "addons", id), { recursive: true });
  writeFileSync(join(cwd, "addons", id, "env.example"), text);
};
const run = (root) => initEnv({ cwd: root.cwd, argv: [], env: {}, stdout: root.stdout });
const SAMPLE = "# Where the thing lives\nTHING_URL=http://thing:8080\n\n# @secret\n# Shared token\nTHING_TOKEN=\n";

test("parseFragment keeps comments with their key and spots @secret", () => {
  const [url, token] = parseFragment(SAMPLE);
  assert.deepEqual(url.comments, ["# Where the thing lives"]);
  assert.equal(url.secret, false);
  assert.equal(token.key, "THING_TOKEN");
  assert.equal(token.secret, true);
  assert.equal(token.comments.length, 2);
});

test("findFragments is sorted and ignores folders without env.example", () => {
  const cwd = mkdtempSync(join(tmpdir(), "addon-"));
  fragment(cwd, "zeta", "A=1\n");
  fragment(cwd, "alpha", "B=1\n");
  mkdirSync(join(cwd, "addons", "empty"));
  assert.deepEqual(findFragments(cwd).map((f) => f.id), ["alpha", "zeta"]);
  assert.deepEqual(findFragments(join(cwd, "nowhere")), []);
});

test("init-env adds fragments, comments included, and generates blank secrets", () => {
  const root = makeRoot();
  fragment(root.cwd, "thing", SAMPLE);
  assert.equal(run(root), 0);
  const text = readFileSync(join(root.cwd, ".env"), "utf8");
  const env = readDotenv(join(root.cwd, ".env"));
  assert.match(text, /# add-on thing\n# Where the thing lives\nTHING_URL=/);
  assert.equal(env.THING_URL, "http://thing:8080");
  assert.match(env.THING_TOKEN, /^[0-9a-f]{64}$/);
  assert.match(root.output(), /generated: .*THING_TOKEN/);
  assert.ok(!root.output().includes(env.THING_TOKEN));
});

test("a rerun is idempotent and never overwrites values", () => {
  const root = makeRoot();
  fragment(root.cwd, "thing", SAMPLE);
  run(root);
  const first = readFileSync(join(root.cwd, ".env"), "utf8");
  const second = makeRoot();
  second.cwd = root.cwd;
  run(second);
  assert.equal(readFileSync(join(root.cwd, ".env"), "utf8"), first);
  const edited = first.replace("THING_URL=http://thing:8080", "THING_URL=http://mine");
  writeFileSync(join(root.cwd, ".env"), edited);
  run(second);
  assert.equal(readDotenv(join(root.cwd, ".env")).THING_URL, "http://mine");
});

test("a blank or placeholder secret already in .env is generated; a set one is kept", () => {
  const cwd = mkdtempSync(join(tmpdir(), "addon-"));
  fragment(cwd, "thing", "# @secret\nA_TOKEN=\n# @secret\nB_TOKEN=\n");
  const result = applyAddonEnv({
    cwd,
    text: "A_TOKEN=replace-before-lan-use\nB_TOKEN=keepme\n",
    makeSecret: () => "gen"
  });
  assert.deepEqual(result.generated, ["A_TOKEN"]);
  assert.deepEqual(result.kept, ["B_TOKEN"]);
  assert.equal(result.text, "A_TOKEN=gen\nB_TOKEN=keepme\n");
});

test("order is deterministic: add-ons by id, keys by file order", () => {
  const cwd = mkdtempSync(join(tmpdir(), "addon-"));
  fragment(cwd, "b", "B2=1\nB1=1\n");
  fragment(cwd, "a", "A1=1\n");
  const { text } = applyAddonEnv({ cwd, text: "X=1\n" });
  assert.equal(text, "X=1\n\n# add-on a\nA1=1\n\n# add-on b\nB2=1\nB1=1\n");
});

test("the first add-on wins a duplicate key and the clash is reported", () => {
  const cwd = mkdtempSync(join(tmpdir(), "addon-"));
  fragment(cwd, "a", "K=1\n");
  fragment(cwd, "b", "K=2\n");
  const { text, conflicts } = applyAddonEnv({ cwd, text: "" });
  assert.equal(readDotenvText(text).K, "1");
  assert.equal(conflicts.length, 1);
});

function readDotenvText(text) {
  const dir = mkdtempSync(join(tmpdir(), "addon-"));
  writeFileSync(join(dir, ".env"), text);
  return readDotenv(join(dir, ".env"));
}
