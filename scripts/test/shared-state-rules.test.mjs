import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "../repository/rules/ast.mjs";
import envReaders from "../repository/rules/env-readers.mjs";
import moduleState from "../repository/rules/module-state.mjs";
import sideEffectImports from "../repository/rules/side-effect-imports.mjs";
import { REGISTRY_READERS } from "../repository/shared-state-ratchet.mjs";
import { CASES, RULES, SAMPLE, ratchetCases, shard } from "./fixtures/shared-state/cases.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CONFIG = "scripts/repository/rules/vendor-terms.json";
const config = readFileSync(join(root, CONFIG), "utf8");
const MODULES = { "side-effect-imports": sideEffectImports, "env-readers": envReaders, "module-state": moduleState };

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
      writeFileSync(target, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
    }
  }
}
const shardFiles = (rule, shards) =>
  Object.fromEntries(
    Object.entries(shards ?? {}).map(([lane, value]) => [`scripts/repository/pending/${rule}/${lane}.json`, value])
  );

// Build a throwaway repository for a case and run its rule on it.
function run(c, args = []) {
  const dir = mkdtempSync(join(tmpdir(), "shared-state-"));
  try {
    const base = { [CONFIG]: config, ...c.base, ...shardFiles(c.rule, c.baseShards) };
    git(dir, "init", "-q");
    if (c.composed) {
      write(dir, { ...base, ...c.files, ...shardFiles(c.rule, c.shards) });
      git(dir, "add", "-A");
      assert.throws(() => git(dir, "rev-parse", "--verify", "HEAD"), "the composed tree has no HEAD commit");
      return MODULES[c.rule]({ root: dir, args });
    }
    write(dir, base);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    git(dir, "tag", "base");
    for (const lane of Object.keys(c.baseShards ?? {})) {
      if (c.shards && !(lane in c.shards))
        rmSync(join(dir, `scripts/repository/pending/${c.rule}/${lane}.json`), { force: true });
    }
    write(dir, { ...c.files, ...(c.shards ? shardFiles(c.rule, c.shards) : {}) });
    git(dir, "add", "-A");
    return MODULES[c.rule]({ root: dir, args, base: "base", env: { CI: "" } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function check(c) {
  const errors = run(c);
  if (c.expect) {
    assert.notEqual(errors.length, 0, "the rule should have failed");
    for (const pattern of c.expect) {
      assert.ok(
        errors.some((error) => pattern.test(error)),
        `no error matches ${pattern}\n${errors.join("\n")}`
      );
    }
  } else assert.deepEqual(errors, []);
}

// The definition fixtures start with no shard at all (the rule is new): a hit must fail, a clean file must pass.
for (const c of CASES)
  test(`${c.expect ? "must fail" : "must pass"}: ${c.rule}: ${c.name}`, () => check({ ...c, base: {} }));

for (const rule of Object.keys(RULES)) {
  for (const c of ratchetCases(rule)) {
    test(`${c.expect ? "must fail" : "must pass"}: ${rule} ratchet: ${c.name}`, () => check({ ...c, rule }));
  }

  test(`${rule}: --fix-pending rewrites a stale shard down to the measured count and deletes an empty one`, () => {
    const { metric, file } = RULES[rule];
    const dir = mkdtempSync(join(tmpdir(), "shared-state-"));
    const path = join(dir, `scripts/repository/pending/${rule}/H.json`);
    try {
      const hits = (n) => Array.from({ length: n }, (_, i) => SAMPLE[rule].hit(i)).join("");
      write(dir, { [CONFIG]: config, [file]: hits(2), ...shardFiles(rule, { H: shard("H", metric, { [file]: 2 }) }) });
      git(dir, "init", "-q");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "base");
      git(dir, "tag", "base");
      const rule_ = MODULES[rule];
      write(dir, { [file]: hits(1) });
      assert.notEqual(rule_({ root: dir, base: "base" }).length, 0);
      assert.deepEqual(rule_({ root: dir, base: "base", args: ["--fix-pending"] }), []);
      assert.equal(JSON.parse(readFileSync(path, "utf8"))[metric].files[file], 1);
      assert.deepEqual(rule_({ root: dir, base: "base" }), []);
      write(dir, { [file]: SAMPLE[rule].clean });
      assert.deepEqual(rule_({ root: dir, base: "base", args: ["--fix-pending"] }), []);
      assert.equal(existsSync(path), false, "an empty shard is deleted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${rule}: --fix-pending refuses to raise a lane total`, () => {
    const { metric, file } = RULES[rule];
    const dir = mkdtempSync(join(tmpdir(), "shared-state-"));
    try {
      write(dir, {
        [CONFIG]: config,
        [file]: SAMPLE[rule].hit(0),
        ...shardFiles(rule, { H: shard("H", metric, { [file]: 1 }) })
      });
      git(dir, "init", "-q");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "base");
      git(dir, "tag", "base");
      write(dir, { "portal/server/new.ts": SAMPLE[rule].hit(7) });
      git(dir, "add", "-A");
      const errors = MODULES[rule]({ root: dir, base: "base", args: ["--fix-pending"] });
      assert.ok(
        errors.some((error) => new RegExp(`Refusing to raise H/${metric} in .* from 1 to 2`).test(error)),
        errors.join("\n")
      );
      assert.equal(
        JSON.parse(readFileSync(join(dir, `scripts/repository/pending/${rule}/H.json`), "utf8"))[metric].total,
        1
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${rule}: a tree that is not a git repository (the add-on conformance copy) is scanned from disk`, () => {
    const { metric, file } = RULES[rule];
    const dir = mkdtempSync(join(tmpdir(), "shared-state-"));
    try {
      write(dir, {
        [CONFIG]: config,
        [file]: SAMPLE[rule].hit(0),
        "portal/node_modules/dep/index.ts": SAMPLE[rule].hit(1),
        "portal/dist/out.ts": SAMPLE[rule].hit(2),
        ...shardFiles(rule, { H: shard("H", metric, { [file]: 1 }) })
      });
      assert.deepEqual(MODULES[rule]({ root: dir }), []);
      write(dir, { "portal/server/new.ts": SAMPLE[rule].hit(3) });
      assert.match(MODULES[rule]({ root: dir }).join("\n"), /portal\/server\/new\.ts is new/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("module-state: S5 and S5b are separate sections of one shard", () => {
  const dir = mkdtempSync(join(tmpdir(), "shared-state-"));
  try {
    write(dir, {
      [CONFIG]: config,
      "portal/server/x.ts": "export let a = 1;\nexport const ids = intervalCalendarSourceIds();\n",
      ...shardFiles("module-state", {
        H: {
          lane: "H",
          state: { total: 1, files: { "portal/server/x.ts": 1 } },
          snapshots: { total: 1, files: { "portal/server/x.ts": 1 } }
        }
      })
    });
    assert.deepEqual(moduleState({ root: dir }), []);
    write(dir, { "portal/server/x.ts": "export let a = 1;\n" });
    assert.match(moduleState({ root: dir }).join("\n"), /portal\/server\/x\.ts now has 0 .*snapshots/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("module-state: S5b covers the portal client folders, S5 does not", () => {
  const dir = mkdtempSync(join(tmpdir(), "shared-state-"));
  try {
    write(dir, {
      [CONFIG]: config,
      "portal/components/x.ts": "export let a = 1;\nexport const s = calendarSinkConnection();\n"
    });
    const errors = moduleState({ root: dir }).join("\n");
    assert.match(errors, /portal\/components\/x\.ts is new .*registry snapshot/s);
    assert.doesNotMatch(errors, /module-level let\/var declaration/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the registry reader list covers every function the connection registry exports", () => {
  const { body } = parse(join(root, "platform/contracts/src/connections/registry.ts"));
  const exported = body
    .filter((s) => s.type === "ExportNamedDeclaration" && s.declaration?.type === "FunctionDeclaration")
    .map((s) => s.declaration.id.name);
  assert.ok(exported.length > 5);
  for (const name of exported) {
    assert.ok(
      REGISTRY_READERS.includes(name),
      `${name} is exported by platform/contracts/src/connections/registry.ts but is missing from REGISTRY_READERS in scripts/repository/shared-state-ratchet.mjs. Add it, so a module-level snapshot of it is counted by S5b.`
    );
  }
});

test("the real tree passes all three rules, and the shards are sharded per lane and sorted", () => {
  for (const rule of Object.values(MODULES)) assert.deepEqual(rule({ root }), []);
  for (const name of Object.keys(RULES)) {
    const dir = join(root, "scripts/repository/pending", name);
    for (const file of readdirSync(dir)) {
      const data = JSON.parse(readFileSync(join(dir, file), "utf8"));
      assert.equal(`${data.lane}.json`, file);
    }
  }
});
