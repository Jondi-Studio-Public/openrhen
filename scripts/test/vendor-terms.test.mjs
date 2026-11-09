import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vendorTerms, { laneOf } from "../repository/rules/vendor-terms.mjs";
import { CASES, CLEAN, SHARD } from "./fixtures/vendor-terms/cases.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtures = join(root, "scripts/test/fixtures/vendor-terms");
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const config = readJson(join(root, "scripts/repository/rules/vendor-terms.json"));
const CONFIG = "scripts/repository/rules/vendor-terms.json";
const TOKENS = "scripts/repository/rules/platform-tokens.json";

const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
function write(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    if (content === null) rmSync(target, { force: true });
    else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
  }
}

// Build a throwaway repository for a case and run the rule on it.
function run(c, args = []) {
  const dir = mkdtempSync(join(tmpdir(), "vendor-terms-"));
  try {
    const exclusions = {
      ...config.exclusions,
      migrations: [],
      legal: [],
      archive: [],
      migrationHistoryTests: [],
      ...c.exclusions
    };
    const baseConfig = { ...config, exclusions };
    const baseFiles = {
      ...CLEAN,
      [CONFIG]: `${JSON.stringify(baseConfig, null, 2)}\n`,
      [TOKENS]: `${JSON.stringify({ entries: c.tokens ?? [] }, null, 2)}\n`,
      ...c.base
    };
    git(dir, "init", "-q");
    if (c.composed) {
      write(dir, { ...baseFiles, ...c.files });
      git(dir, "add", "-A");
      assert.throws(() => git(dir, "rev-parse", "--verify", "HEAD"), "the composed tree has no HEAD commit");
      return vendorTerms({ root: dir, args });
    }
    write(dir, baseFiles);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    git(dir, "tag", "base");
    if (c.configAfter) {
      const after = structuredClone(baseConfig);
      c.configAfter(after);
      write(dir, { [CONFIG]: `${JSON.stringify(after, null, 2)}\n` });
    }
    write(dir, c.files ?? {});
    git(dir, "add", "-A");
    if (c.commitAfter) git(dir, "commit", "-q", "-m", "after");
    return vendorTerms({ root: dir, args, base: c.baseRef ?? "base", env: c.env ?? { CI: "" } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const c of CASES) {
  if (c.expect) {
    test(`must fail: ${c.name}`, () => {
      const errors = run(c);
      assert.notEqual(errors.length, 0, "the rule should have failed");
      for (const pattern of c.expect) {
        assert.ok(
          errors.some((error) => pattern.test(error)),
          `no error matches ${pattern}\n${errors.join("\n")}`
        );
      }
    });
  } else {
    test(`must pass: ${c.name}`, () => {
      assert.deepEqual(run(c), []);
    });
  }
}

test("--fix-pending rewrites a stale shard down to the measured count", () => {
  const dir = mkdtempSync(join(tmpdir(), "vendor-terms-"));
  try {
    write(dir, {
      ...CLEAN,
      [CONFIG]: `${JSON.stringify({ ...config, exclusions: { ...config.exclusions, migrations: [], legal: [], archive: [] } })}\n`,
      [TOKENS]: '{"entries":[]}\n'
    });
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    git(dir, "tag", "base");
    write(dir, { "src/old.ts": "// google\n" });
    assert.notEqual(vendorTerms({ root: dir, base: "base" }).length, 0);
    assert.deepEqual(vendorTerms({ root: dir, base: "base", args: ["--fix-pending"] }), []);
    assert.equal(readJson(join(dir, SHARD("other"))).terms.files["src/old.ts"], 1);
    assert.deepEqual(vendorTerms({ root: dir, base: "base" }), []);
    // A file with no hits left drops out of its shard, and an empty shard is deleted.
    write(dir, { "src/old.ts": "export const x = 1;\n" });
    assert.deepEqual(vendorTerms({ root: dir, base: "base", args: ["--fix-pending"] }), []);
    assert.throws(() => readFileSync(join(dir, SHARD("other"))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--fix-pending refuses to raise a lane total", () => {
  const dir = mkdtempSync(join(tmpdir(), "vendor-terms-"));
  try {
    write(dir, {
      ...CLEAN,
      [CONFIG]: `${JSON.stringify({ ...config, exclusions: { ...config.exclusions, migrations: [], legal: [], archive: [] } })}\n`,
      [TOKENS]: '{"entries":[]}\n'
    });
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    git(dir, "tag", "base");
    write(dir, { "src/new.ts": "// google\n" });
    git(dir, "add", "-A");
    const errors = vendorTerms({ root: dir, base: "base", args: ["--fix-pending"] });
    assert.ok(
      errors.some((error) => /Refusing to raise other\/terms from 2 to 3/.test(error)),
      errors.join("\n")
    );
    assert.equal(readJson(join(dir, SHARD("other"))).terms.total, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("without a base commit to compare to, the per-file counts still hold", () => {
  const dir = mkdtempSync(join(tmpdir(), "vendor-terms-"));
  try {
    write(dir, {
      ...CLEAN,
      [CONFIG]: `${JSON.stringify({ ...config, exclusions: { ...config.exclusions, migrations: [], legal: [], archive: [] } })}\n`,
      [TOKENS]: '{"entries":[]}\n',
      "src/x.ts": "// google\n"
    });
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    const errors = vendorTerms({ root: dir });
    assert.ok(errors.some((error) => /src\/x\.ts is new/.test(error)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the real tree passes the rule", () => {
  // CI empty: the unit-test job checks out one commit, so the base comparison is left to the structure check (depth 2).
  assert.deepEqual(vendorTerms({ root, env: { CI: "" } }), []);
});

test("the term sets only grow: every pinned term is still in vendor-terms.json", () => {
  const { terms: pinned } = readJson(join(fixtures, "pinned-terms.json"));
  const now = config.terms;
  const has = (list, term) => assert.ok(list.includes(term), `${term} was removed from the term sets`);
  for (const term of pinned.provider) has(now.provider, term);
  for (const [set, terms] of Object.entries(pinned.wider)) for (const term of terms) has(now.wider[set] ?? [], term);
  for (const term of pinned.capitalised) has(now.capitalised, term);
  for (const term of pinned.owner) has(now.owner, term);
  for (const term of pinned.agents.substring) has(now.agents.substring, term);
  for (const term of pinned.agents.word) has(now.agents.word, term);
  for (const term of pinned.pathWords) has(now.pathWords, term);
});

test("platform-tokens.json is exactly the table this test expects", () => {
  const actual = readJson(join(root, TOKENS));
  const expected = readJson(join(fixtures, "expected-platform-tokens.json"));
  assert.deepEqual(actual.entries, expected.entries);
  assert.deepEqual(actual.categories, [
    "standard-endpoint",
    "platform-detection",
    "security-deny-list",
    "toolchain",
    "interop-corpus"
  ]);
  for (const row of actual.entries) {
    assert.ok(actual.categories.includes(row.category), `${row.path}: unknown category ${row.category}`);
    assert.ok(row.why && row.strings.length > 0, `${row.path}: a row needs strings and a reason`);
  }
});

test("the exemption lists are exactly the closed lists this test expects", () => {
  const e = config.exclusions;
  const expected = readJson(join(fixtures, "expected-exclusions.json"));
  const { _comment, ...closed } = expected;
  assert.deepEqual(
    {
      history: e.history,
      snapshots: e.snapshots,
      lastAppliedMigration: e.lastAppliedMigration,
      migrations: e.migrations,
      migrationHistoryTests: e.migrationHistoryTests,
      legal: e.legal,
      archivePrefix: e.archivePrefix,
      archive: e.archive.map((entry) => entry.path),
      own: e.own
    },
    closed
  );
});

test("the physiology guard reads its device makers from the rule's term file", () => {
  const source = readFileSync(join(root, "portal/server/physiology-schema.test.ts"), "utf8");
  assert.match(source, /vendor-terms\.json/);
  assert.ok(config.terms.wider.deviceMakers.length >= 15);
});

test("paths map to the plan's lanes", () => {
  const lane = (path) => laneOf(config, path);
  assert.equal(lane("package.json"), "G");
  assert.equal(lane("compose.yaml"), "Y");
  assert.equal(lane("integrations/outbound-proxy/Dockerfile"), "Y");
  assert.equal(lane("portal/server/x.ts"), "H");
  assert.equal(lane("portal/features/x.ts"), "U");
  assert.equal(lane("platform/contracts/src/data-flow/entries/x.ts"), "F");
  assert.equal(lane("platform/contracts/src/x.ts"), "K");
  assert.equal(lane("platform/database/src/planning/x.ts"), "W");
  assert.equal(lane("platform/database/src/schema/core.ts"), "D");
  assert.equal(lane("scripts/smoke/x.mjs"), "S");
  assert.equal(lane("scripts/repository/x.mjs"), "G");
  assert.equal(lane("docs/README.md"), "docs");
  assert.equal(lane("integrations/openclaw-plugin/index.js"), "other");
});

test("a tree that is not a git repository (the add-on conformance copy) is scanned from disk, not an error", () => {
  const dir = mkdtempSync(join(tmpdir(), "vendor-terms-nogit-"));
  try {
    write(dir, {
      ...CLEAN,
      [CONFIG]: `${JSON.stringify(config, null, 2)}\n`,
      [TOKENS]: `${JSON.stringify({ entries: [] }, null, 2)}\n`,
      "src/x.ts": "export const x = 'google';\n",
      "node_modules/y/index.js": "google\n",
      "tsconfig.tsbuildinfo": "google\n"
    });
    const errors = vendorTerms({ root: dir, args: [] });
    assert.ok(
      errors.some((e) => e.includes("src/x.ts")),
      errors.join("\n")
    );
    assert.ok(!errors.some((e) => e.includes("node_modules") || e.includes("tsbuildinfo")), errors.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the pinned hashes catch an edited frozen file whose hash was edited with it", () => {
  const expected = readJson(join(fixtures, "expected-exclusions.json"));
  const edited = structuredClone(config.exclusions.legal);
  edited[0].sha256 = "0".repeat(64);
  assert.notDeepEqual(edited, expected.legal);
  const editedMigrations = structuredClone(config.exclusions.migrations);
  editedMigrations[0].sha256 = "0".repeat(64);
  assert.notDeepEqual(editedMigrations, expected.migrations);
});

test("the defaults, schema files and lanes only grow: every pinned entry is still there", () => {
  const pinned = readJson(join(fixtures, "pinned-terms.json"));
  const strip = ({ why: _why, ...rest }) => JSON.stringify(rest);
  for (const entry of pinned.defaults) {
    const now = config.defaults.find((candidate) => candidate.id === entry.id);
    assert.ok(now && strip(now) === strip(entry), `default ${entry.id} was removed or changed`);
  }
  for (const file of pinned.schemaFiles) assert.ok(config.schema.files.includes(file), `${file} left schema.files`);
  for (const entry of pinned.lanes) {
    const globs = config.lanes.filter((lane) => lane.lane === entry.lane).flatMap((lane) => lane.globs);
    for (const glob of entry.globs) assert.ok(globs.includes(glob), `lane ${entry.lane} lost ${glob}`);
  }
});
