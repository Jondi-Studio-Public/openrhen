import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadAddonWriters } from "../repository/addon-routes.mjs";
import writeOwners from "../repository/rules/write-owners.mjs";
import { OPERATIONS_WRITERS, PLAN_INPUT_TABLES, TABLE_OWNERS, WRITERS } from "../repository/write-path-registry.mjs";
import { ADDON_BASE, BASE, BASE_SHARDS, FAIL, PASS, PG, REGISTRY, shardOf } from "./fixtures/write-owners/cases.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CONFIG = "scripts/repository/rules/vendor-terms.json";
const config = readFileSync(join(root, CONFIG), "utf8");
const PENDING = "scripts/repository/pending/write-owners";

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
const shardFiles = (shards) =>
  Object.fromEntries(Object.entries(shards).map(([lane, value]) => [`${PENDING}/${lane}.json`, value]));
const registryOf = (c) => ({ ...REGISTRY, ...c.registry });

// Build a throwaway repository for a case and run the rule on it.
function run(c, args = []) {
  const dir = mkdtempSync(join(tmpdir(), "write-owners-"));
  try {
    const baseShards = c.baseShards ?? BASE_SHARDS;
    const registry = registryOf(c);
    git(dir, "init", "-q");
    if (c.composed) {
      write(dir, {
        [CONFIG]: config,
        ...BASE,
        ...ADDON_BASE,
        ...c.base,
        ...shardFiles(c.shards ?? baseShards),
        ...(c.syncCore ? { ".sync-core.json": c.syncCore } : {}),
        ...c.files
      });
      git(dir, "add", "-A");
      assert.throws(() => git(dir, "rev-parse", "--verify", "HEAD"), "the composed tree has no HEAD commit");
      return writeOwners({ root: dir, args, registry });
    }
    write(dir, { [CONFIG]: config, ...BASE, ...c.base, ...shardFiles(baseShards) });
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    git(dir, "tag", "base");
    for (const lane of Object.keys(baseShards)) {
      if (c.shards && !(lane in c.shards)) rmSync(join(dir, PENDING, `${lane}.json`), { force: true });
    }
    write(dir, { ...c.files, ...(c.shards ? shardFiles(c.shards) : {}) });
    git(dir, "add", "-A");
    return writeOwners({ root: dir, args, base: "base", env: { CI: "" }, registry });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const c of FAIL) {
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
}

for (const c of PASS) {
  test(`must pass: ${c.name}`, () => {
    assert.deepEqual(run(c), []);
  });
}

// ---- --fix-pending, in a throwaway repository

function withRepo(files, body, { commit = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "write-owners-"));
  try {
    git(dir, "init", "-q");
    write(dir, { [CONFIG]: config, ...files });
    git(dir, "add", "-A");
    if (commit) {
      git(dir, "commit", "-q", "-m", "base");
      git(dir, "tag", "base");
    }
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const readShard = (dir, lane) => JSON.parse(readFileSync(join(dir, PENDING, `${lane}.json`), "utf8"));

test("--fix-pending seeds the shards when none exist, and the seeded shards pass", () => {
  withRepo(
    BASE,
    (dir) => {
      const registry = REGISTRY;
      assert.notEqual(writeOwners({ root: dir, registry }).length, 0, "no shards: the writers fail");
      assert.deepEqual(writeOwners({ root: dir, registry, args: ["--fix-pending"] }), []);
      const h = readShard(dir, "H");
      assert.deepEqual(h.rows.files, BASE_SHARDS.H.rows.files);
      assert.equal(h.rows.total, 3);
      assert.deepEqual(writeOwners({ root: dir, registry }), []);
    },
    { commit: false }
  );
});

test("--fix-pending deletes stale rows and an empty shard, and refuses to add a row", () => {
  withRepo({ ...BASE, ...shardFiles(BASE_SHARDS) }, (dir) => {
    const ctx = { root: dir, base: "base", env: { CI: "" }, registry: REGISTRY };
    write(dir, { [`${PG}commit-writer.ts`]: "export const none = 1;\n" });
    assert.notEqual(writeOwners(ctx).length, 0);
    assert.deepEqual(writeOwners({ ...ctx, args: ["--fix-pending"] }), []);
    assert.deepEqual(Object.keys(readShard(dir, "H").rows.files).sort(), [
      `${PG}entity-commands.ts`,
      `${PG}session-writer.ts`
    ]);
    write(dir, { [`${PG}new-writer.ts`]: BASE[`${PG}commit-writer.ts`] });
    git(dir, "add", "-A");
    const errors = writeOwners({ ...ctx, args: ["--fix-pending"] });
    assert.ok(
      errors.some((error) =>
        /Refusing to add the row .*new-writer\.ts.*commitments.* pending rows only shrink/s.test(error)
      ),
      errors.join("\n")
    );
    assert.equal(readShard(dir, "H").rows.files[`${PG}new-writer.ts`], undefined);
    write(dir, {
      [`${PG}new-writer.ts`]: null,
      [`${PG}entity-commands.ts`]: "export const note = recordStateChange;\n",
      [`${PG}session-writer.ts`]: "export const none = 1;\n"
    });
    assert.deepEqual(writeOwners({ ...ctx, args: ["--fix-pending"] }), []);
    assert.equal(existsSync(join(dir, PENDING, "H.json")), false, "an empty shard is deleted");
  });
});

test("--fix-pending refuses to raise a lane's dynamic total", () => {
  const dynamic = 'export const run = (tx, t) => tx.unsafe("DELETE FROM " + t);\n';
  withRepo(
    {
      ...BASE,
      [`${PG}dyn.ts`]: dynamic,
      ...shardFiles({ H: shardOf("H", BASE_SHARDS.H.rows.files, { [`${PG}dyn.ts`]: 1 }) })
    },
    (dir) => {
      write(dir, { [`${PG}dyn.ts`]: `${dynamic}${dynamic.replace("DELETE FROM", "UPDATE")}` });
      const errors = writeOwners({
        root: dir,
        base: "base",
        env: { CI: "" },
        registry: REGISTRY,
        args: ["--fix-pending"]
      });
      assert.ok(
        errors.some((error) => /Refusing to raise H dynamic .* from 1 to 2/.test(error)),
        errors.join("\n")
      );
      assert.equal(readShard(dir, "H").dynamic.total, 1);
    }
  );
});

test("a tree that is not a git repository (the add-on conformance copy) is scanned from disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "write-owners-"));
  try {
    write(dir, {
      [CONFIG]: config,
      ...BASE,
      "portal/node_modules/dep/index.ts": BASE[`${PG}commit-writer.ts`],
      "portal/dist/out.ts": BASE[`${PG}commit-writer.ts`],
      ...shardFiles(BASE_SHARDS)
    });
    assert.deepEqual(writeOwners({ root: dir, registry: REGISTRY }), []);
    write(dir, { [`${PG}new-writer.ts`]: BASE[`${PG}commit-writer.ts`] });
    assert.match(writeOwners({ root: dir, registry: REGISTRY }).join("\n"), /new-writer\.ts writes commitments/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test files, drizzle sets, and the add-on example's overlay are not writers", () => {
  const statement = BASE[`${PG}commit-writer.ts`];
  withRepo({ ...BASE, ...shardFiles(BASE_SHARDS) }, (dir) => {
    write(dir, {
      [`${PG}x.test.ts`]: statement,
      [`${PG}x-test-fixtures.ts`]: statement,
      "scripts/backup/record-run.test.mjs": statement,
      "platform/database/drizzle/0003.ts": statement,
      "integrations/addon-example/overlay/portal/server/y.ts": statement
    });
    git(dir, "add", "-A");
    assert.deepEqual(writeOwners({ root: dir, base: "base", env: { CI: "" }, registry: REGISTRY }), []);
  });
});

// ---- the add-on writer hook's reader

test("loadAddonWriters reads owns and writers from addons/*/*/write-paths.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "write-owners-"));
  try {
    write(dir, {
      "addons/notes/server/write-paths.json": {
        owns: { "notes.entries": "addons/notes/server/entries.ts" },
        writers: { "addons/notes/server/entries.ts": { class: "owner", reason: "the add-on's own store" } }
      },
      "addons/notes/worker/write-paths.json": { owns: { notes_tags: "addons/notes/worker/tags.ts" } },
      "portal/app/(addon)/hello/write-paths.json": {
        "portal/app/(addon)/hello/page.tsx": { class: "helper", reason: "x", owners: [] }
      }
    });
    const loaded = loadAddonWriters(dir);
    assert.deepEqual(loaded.errors, []);
    assert.deepEqual(loaded.owns, [
      {
        file: "addons/notes/server/write-paths.json",
        addon: "notes",
        table: "notes.entries",
        owner: "addons/notes/server/entries.ts"
      },
      {
        file: "addons/notes/worker/write-paths.json",
        addon: "notes",
        table: "notes_tags",
        owner: "addons/notes/worker/tags.ts"
      }
    ]);
    assert.deepEqual(Object.keys(loaded.writers).sort(), [
      "addons/notes/server/entries.ts",
      "portal/app/(addon)/hello/page.tsx"
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadAddonWriters refuses a malformed add-on owns row or a writer outside its package", () => {
  const dir = mkdtempSync(join(tmpdir(), "write-owners-"));
  try {
    write(dir, {
      "addons/notes/server/write-paths.json": {
        owns: { a: "addons/other/server/x.ts", b: 3 },
        writers: {
          "addons/notes/worker/x.ts": { class: "owner", reason: "x" },
          "addons/notes/server/y.ts": { class: "retention", reason: "x" }
        }
      },
      "addons/notes/worker/write-paths.json": "{ not json"
    });
    const errors = loadAddonWriters(dir).errors.join("\n");
    assert.match(errors, /owns a in addons\/other\/server\/x\.ts, which is outside the package/);
    assert.match(errors, /owns b without a file/);
    assert.match(errors, /registers addons\/notes\/worker\/x\.ts, which is outside the folder it sits in/);
    assert.match(errors, /class retention/);
    assert.match(errors, /addons\/notes\/worker\/write-paths\.json is not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the real registry and the real tree

const schemaTables = [
  ...readFileSync(join(root, "platform/database/src/schema/core.ts"), "utf8").matchAll(/pgTable\(\s*"([^"]+)"/g)
].map((match) => match[1]);

test("TABLE_OWNERS has one row for every pgTable in schema/core.ts, and only photo_checkin_stage has no owner", () => {
  assert.deepEqual(Object.keys(TABLE_OWNERS).sort(), [...schemaTables].sort());
  const unowned = Object.entries(TABLE_OWNERS)
    .filter(([, row]) => row.owner === null)
    .map(([name]) => name);
  assert.deepEqual(unowned, ["photo_checkin_stage"]);
  for (const [name, row] of Object.entries(TABLE_OWNERS)) {
    if (row.owner !== null) assert.match(row.owner, /^[a-z0-9/_.()-]+\.(?:ts|mjs)$/, `${name} names a repo path`);
  }
});

test("the only exemption is the backup sidecar's insert into integration_sync_runs", () => {
  const exempt = Object.entries(TABLE_OWNERS).flatMap(([name, row]) =>
    Object.entries(row.exempt ?? {}).map(([file, reason]) => [name, file, typeof reason])
  );
  assert.deepEqual(exempt, [["integration_sync_runs", "scripts/backup/record-run.mjs", "string"]]);
  assert.equal(TABLE_OWNERS.integration_sync_runs.owner, "portal/server/persistence/postgres/run-log.ts");
});

test("the store class has three prefix entries and two exact paths, each of which exists", () => {
  const stores = Object.entries(WRITERS).filter(([, entry]) => entry.class === "store");
  assert.deepEqual(
    stores.map(([path]) => path).sort(),
    [
      "platform/database/src/stores/",
      "portal/server/persistence/postgres/activity-store.ts",
      "portal/server/persistence/postgres/entities/",
      "portal/server/persistence/postgres/plan-map-store.ts",
      "portal/server/persistence/postgres/stores/"
    ].sort()
  );
  for (const [path] of stores) assert.ok(existsSync(join(root, path)), `${path} exists`);
  for (const folder of stores.map(([path]) => path).filter((path) => path.endsWith("/"))) {
    const lines = readFileSync(join(root, folder, "README.md"), "utf8")
      .trim()
      .split("\n");
    assert.equal(lines.length, 1, `${folder}README.md is one line`);
    assert.ok(lines[0].length > 20);
  }
});

test("OPERATIONS_WRITERS names the three operations files that hold a write today", () => {
  assert.deepEqual(
    [...OPERATIONS_WRITERS].sort(),
    [
      "platform/database/src/operations/migrate-on-deploy.ts",
      "platform/database/src/operations/restore-run.ts",
      "platform/database/src/operations/smoke-seed-late-commitment.ts"
    ].sort()
  );
  for (const path of OPERATIONS_WRITERS) assert.ok(existsSync(join(root, path)), `${path} exists`);
});

test("the plan-input list is a subset of the tables, and TABLE_OWNERS names owners in the layers the plan's rule 3 sets", () => {
  for (const name of PLAN_INPUT_TABLES) assert.ok(name in TABLE_OWNERS, name);
  const layer = (name) => TABLE_OWNERS[name].owner?.split("/").slice(0, 4).join("/");
  assert.equal(layer("write_rows"), "platform/database/src/stores");
  assert.equal(layer("provider_call_telemetry"), "platform/database/src/stores");
  assert.equal(layer("journey_samples"), "platform/database/src/stores");
  assert.equal(layer("actions"), "platform/database/src/stores");
  assert.equal(
    TABLE_OWNERS.calendar_publications.owner,
    "portal/server/persistence/postgres/stores/calendar-publications.ts"
  );
});

test("the seeded shards hold exactly the (file, table) pairs whose file is not the table's owner", () => {
  const dir = join(root, PENDING);
  const lanes = readdirSync(dir).filter((name) => name.endsWith(".json"));
  assert.deepEqual(lanes.sort(), ["H.json", "N.json", "W.json"]);
  for (const name of lanes) {
    const shard = JSON.parse(readFileSync(join(dir, name), "utf8"));
    assert.equal(shard.lane, name.slice(0, -5));
    const sum = Object.values(shard.rows.files).reduce((a, tables) => a + tables.length, 0);
    assert.equal(shard.rows.total, sum, `${name} rows total`);
    for (const [file, tables] of Object.entries(shard.rows.files)) {
      assert.deepEqual(tables, [...new Set(tables)].sort(), `${file} lists sorted, distinct tables`);
      for (const table of tables) assert.notEqual(TABLE_OWNERS[table]?.owner, file, `${file} owns ${table}`);
    }
  }
});

test("the rule passes on this repository", () => {
  assert.deepEqual(writeOwners({ root, base: "HEAD", env: { CI: "" } }), []);
});
