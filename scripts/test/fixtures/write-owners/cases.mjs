// Fixtures for the write-owner rule (modularity W0, scripts/repository/rules/write-owners.mjs). Each case names the
// files that change on top of a small base tree, the shards the working tree declares, and (for a must-fail case)
// the messages the rule must print. The rule is handed a fixture registry (`ctx.registry`), so the cases do not depend
// on the real TABLE_OWNERS.

export const OPS = "platform/database/src/operations/";
export const PG = "portal/server/persistence/postgres/";
export const STORES = "platform/database/src/stores/";
const SCHEMA = "platform/database/src/schema/core.ts";
export const SCHEMA_PATH = SCHEMA;

const table = (name) => `export const ${name} = pgTable("${name}", {});\n`;
export const schemaOf = (...names) => `import { pgTable } from "drizzle-orm/pg-core";\n${names.map(table).join("")}`;

// The fixture registry: five tables, one owner that exists (push_outbox), owners that do not exist yet (commitments,
// sessions, spans), and the one pinned exemption.
export const REGISTRY = {
  TABLE_OWNERS: {
    commitments: { owner: `${STORES}commitments.ts` },
    sessions: { owner: `${PG}stores/sessions.ts` },
    spans: { owner: `${PG}entities/span.ts` },
    push_outbox: { owner: `${STORES}push-outbox.ts` },
    integration_sync_runs: {
      owner: `${PG}run-log.ts`,
      exempt: {
        "scripts/backup/record-run.mjs": "the backup sidecar runs plain node and cannot import a TypeScript owner"
      }
    }
  },
  OPERATIONS_WRITERS: [`${OPS}restore-run.ts`],
  TEST_HARNESS_WRITERS: [`${PG}state-store-harness.ts`],
  PLAN_INPUT_TABLES: ["commitments", "sessions", "spans"],
  WRITERS: {
    [STORES]: { class: "store", reason: "database table owners" },
    [`${PG}stores/`]: { class: "store", reason: "portal table owners" },
    [`${PG}entities/`]: { class: "store", reason: "entity handlers" },
    [OPS]: { class: "operations", reason: "backup, restore, migration and seed" },
    [`${PG}entity-commands.ts`]: { class: "owner", reason: "entity commands" },
    [`${PG}close-commands.ts`]: { class: "owner", reason: "close commands" }
  }
};

const sql = (statement) => `export const run = (sql) => sql\`${statement}\`;\n`;

export const BASE = {
  [SCHEMA]: schemaOf("commitments", "sessions", "spans", "push_outbox", "integration_sync_runs"),
  [`${PG}commit-writer.ts`]: sql("UPDATE commitments SET title = 'x'"),
  [`${PG}session-writer.ts`]: sql("DELETE FROM sessions WHERE id = 1"),
  [`${PG}entity-commands.ts`]: `${sql("INSERT INTO spans (id) VALUES (1)")}export const note = recordStateChange;\n`,
  [`${PG}run-log.ts`]: sql("INSERT INTO integration_sync_runs (id) VALUES (1)"),
  [`${PG}close-commands.ts`]: "export const close = recordStateChange;\n",
  [`${STORES}push-outbox.ts`]: sql("INSERT INTO push_outbox (id) VALUES (1)"),
  [`${OPS}restore-run.ts`]: `export const run = (sql, table) => sql.unsafe(\`INSERT INTO "\${table}" (a) VALUES (1)\`);\n`,
  [`${PG}state-store-harness.ts`]: "export const harness = 1;\n",
  "scripts/backup/record-run.mjs": sql("INSERT INTO integration_sync_runs (id) VALUES (1)")
};

export const BASE_SHARDS = {
  H: {
    lane: "H",
    rows: {
      total: 3,
      files: {
        [`${PG}commit-writer.ts`]: ["commitments"],
        [`${PG}entity-commands.ts`]: ["spans"],
        [`${PG}session-writer.ts`]: ["sessions"]
      }
    }
  }
};

export const shardOf = (lane, rows = {}, dynamic = {}) => {
  const sum = (object) => Object.values(object).reduce((a, b) => a + (Array.isArray(b) ? b.length : b), 0);
  const shard = { lane };
  if (Object.keys(rows).length) shard.rows = { total: sum(rows), files: rows };
  if (Object.keys(dynamic).length) shard.dynamic = { total: sum(dynamic), files: dynamic };
  return shard;
};

const baseRows = BASE_SHARDS.H.rows.files;
const without = (object, key) => Object.fromEntries(Object.entries(object).filter(([name]) => name !== key));
const H = (rows, dynamic) => ({ H: shardOf("H", rows, dynamic) });

// An addon package in the composed fixture trees: its SQL set creates two tables, one schema-qualified.
export const ADDON_SQL =
  "CREATE TABLE IF NOT EXISTS notes.entries (id int);\nCREATE TABLE IF NOT EXISTS notes_tags (id int);\n";
export const ADDON_OWNS = {
  owns: { "notes.entries": "addons/notes/server/entries.ts", notes_tags: "addons/notes/server/tags.ts" },
  writers: {}
};
const ADDON_BASE = {
  "addons/notes/drizzle/0001_notes.sql": ADDON_SQL,
  "addons/notes/server/package.json": "{}\n",
  "addons/notes/server/write-paths.json": ADDON_OWNS,
  "addons/notes/server/entries.ts": sql("INSERT INTO notes.entries (id) VALUES (1)"),
  "addons/notes/server/tags.ts": sql("INSERT INTO notes_tags (id) VALUES (1)")
};

// Must-fail cases. `files` replace or add files (null deletes); `shards` replace the working shards (default: the base
// ones); `registry` shallow-merges into REGISTRY.
export const FAIL = [
  {
    name: "a new file with UPDATE commitments, not in a shard",
    files: { [`${PG}new-writer.ts`]: sql("UPDATE commitments SET title = 'y'") },
    expect: [
      /new-writer\.ts writes commitments, which platform\/database\/src\/stores\/commitments\.ts owns \(write-path-registry\.mjs TABLE_OWNERS\): call the owner's function instead/
    ]
  },
  {
    name: 'a new file with DELETE FROM public."sessions"',
    files: { [`${PG}new-writer.ts`]: 'export const run = (tx) => tx`DELETE FROM public."sessions" WHERE id = 1`;\n' },
    expect: [/new-writer\.ts writes sessions, which portal\/server\/persistence\/postgres\/stores\/sessions\.ts owns/]
  },
  {
    name: "a stale shard row (the file no longer writes the table)",
    files: { [`${PG}commit-writer.ts`]: "export const none = 1;\n" },
    expect: [
      /commit-writer\.ts no longer writes commitments\b.*stale/s,
      /remove .*commit-writer\.ts.* commitments from scripts\/repository\/pending\/write-owners\/H\.json, or run `pnpm structure:check --fix-pending`/
    ]
  },
  {
    name: "a new shard row against the merge-base",
    files: { [`${PG}new-writer.ts`]: sql("UPDATE commitments SET title = 'y'") },
    shards: H({ ...baseRows, [`${PG}new-writer.ts`]: ["commitments"] }),
    expect: [/gains the row .*new-writer\.ts.*commitments.*pending rows only shrink/s]
  },
  {
    name: "a swap: one row deleted and a row for another table added in the same lane",
    files: {
      [`${PG}commit-writer.ts`]: sql("UPDATE sessions SET x = 1")
    },
    shards: H({ ...without(baseRows, `${PG}commit-writer.ts`), [`${PG}commit-writer.ts`]: ["sessions"] }),
    expect: [/gains the row .*commit-writer\.ts.*sessions/s]
  },
  {
    name: "a new pgTable with no TABLE_OWNERS row",
    files: {
      [SCHEMA]: schemaOf("commitments", "sessions", "spans", "push_outbox", "integration_sync_runs", "brand_new")
    },
    expect: [/brand_new is in schema\/core\.ts but has no TABLE_OWNERS row/]
  },
  {
    name: "a TABLE_OWNERS row for a table that is neither in the schema nor dropped",
    registry: { TABLE_OWNERS: { ...REGISTRY.TABLE_OWNERS, ghost: { owner: `${STORES}ghost.ts` } } },
    expect: [/TABLE_OWNERS names ghost, which is not in schema\/core\.ts and no migration drops/]
  },
  {
    name: "a new tx`UPDATE ${tx(table)}` outside operations/",
    files: { [`${PG}dyn.ts`]: "export const run = (tx, table) => tx`UPDATE ${tx(table)} SET a = 1`;\n" },
    expect: [/dyn\.ts writes a table that is not a literal/, /1 non-literal write/]
  },
  {
    name: 'tx.unsafe(`UPDATE "${name}" ...`)',
    files: { [`${PG}dyn.ts`]: 'export const run = (tx, name) => tx.unsafe(`UPDATE "${name}" SET a = 1`);\n' },
    expect: [/dyn\.ts writes a table that is not a literal/]
  },
  {
    name: 'tx.unsafe("DELETE FROM " + table)',
    files: { [`${PG}dyn.ts`]: 'export const run = (tx, table) => tx.unsafe("DELETE FROM " + table);\n' },
    expect: [/dyn\.ts writes a table that is not a literal/]
  },
  {
    name: "a dynamic write in a file the shard allows none for, even if the lane total would stay level",
    files: { [`${PG}dyn.ts`]: 'export const run = (tx, table) => tx.unsafe("DELETE FROM " + table);\n' },
    shards: H(baseRows, { [`${PG}other.ts`]: 1 }),
    expect: [/dyn\.ts writes a table that is not a literal/, /other\.ts now has 0 non-literal writes\b.*stale/s]
  },
  {
    name: "a lane's dynamic total rises against the merge-base",
    baseShards: H(baseRows, { [`${PG}dyn.ts`]: 1 }),
    base: { [`${PG}dyn.ts`]: 'export const run = (tx, t) => tx.unsafe("DELETE FROM " + t);\n' },
    files: {
      [`${PG}dyn.ts`]: 'export const run = (tx, t) => [tx.unsafe("DELETE FROM " + t), tx.unsafe("UPDATE " + t)];\n'
    },
    shards: H(baseRows, { [`${PG}dyn.ts`]: 2 }),
    expect: [/Lane H dynamic total rises from 1 .* to 2/]
  },
  {
    name: "a new writer file under operations/",
    files: { [`${OPS}extra-seed.ts`]: sql("INSERT INTO sessions (id) VALUES (1)") },
    expect: [/operations\/extra-seed\.ts writes a table but is not in OPERATIONS_WRITERS/]
  },
  {
    name: "a portal runtime file importing operations/restore-run.ts",
    files: {
      "portal/server/uses-restore.ts":
        'import { run } from "../../platform/database/src/operations/restore-run.js";\nexport { run };\n'
    },
    expect: [
      /uses-restore\.ts imports platform\/database\/src\/operations\/restore-run\.ts, which is in OPERATIONS_WRITERS/
    ]
  },
  {
    name: "a second exemption",
    registry: {
      TABLE_OWNERS: {
        ...REGISTRY.TABLE_OWNERS,
        sessions: { owner: `${PG}stores/sessions.ts`, exempt: { [`${PG}session-writer.ts`]: "convenience" } }
      }
    },
    expect: [/TABLE_OWNERS exempts .*session-writer\.ts for sessions\b.*only .*record-run\.mjs.*integration_sync_runs/s]
  },
  {
    name: "the pinned exempt file writes another table",
    files: {
      "scripts/backup/record-run.mjs": `${sql("INSERT INTO integration_sync_runs (id) VALUES (1)")}${sql("UPDATE commitments SET a = 1")}`
    },
    expect: [
      /scripts\/backup\/record-run\.mjs writes commitments, but its one exemption covers only integration_sync_runs/
    ]
  },
  {
    name: "an owner that exists does not write its table once no shard row is left",
    files: {
      [`${PG}stores/sessions.ts`]: "export const none = 1;\n",
      [`${PG}session-writer.ts`]: "export const none = 1;\n"
    },
    shards: H(without(baseRows, `${PG}session-writer.ts`)),
    expect: [/owner portal\/server\/persistence\/postgres\/stores\/sessions\.ts does not write sessions/]
  },
  {
    name: "a drizzle builder write outside the owner",
    files: { [`${PG}builder.ts`]: "export const run = (db) => db.update(commitments).set({});\n" },
    expect: [/builder\.ts writes commitments through the query builder/]
  },
  {
    name: "an owner that owns both a plan-input and a non-plan-input table",
    registry: {
      TABLE_OWNERS: {
        ...REGISTRY.TABLE_OWNERS,
        push_outbox: { owner: `${STORES}commitments.ts` }
      }
    },
    files: {
      [`${STORES}commitments.ts`]: `${sql("UPDATE commitments SET a = 1")}${sql("INSERT INTO push_outbox (id) VALUES (1)")}`,
      [`${STORES}push-outbox.ts`]: null
    },
    shards: H(without(baseRows, `${PG}commit-writer.ts`)),
    expect: [/commitments\.ts owns both plan-input table\(s\) commitments and non-plan-input table\(s\) push_outbox/]
  },
  {
    name: "a core file that imports a plan-input store and is not registered",
    files: {
      [`${STORES}commitments.ts`]: sql("UPDATE commitments SET a = 1"),
      [`${PG}commit-writer.ts`]: null,
      "portal/server/caller.ts":
        'import { run } from "../../platform/database/src/stores/commitments.js";\nexport { run };\n'
    },
    shards: H(without(baseRows, `${PG}commit-writer.ts`)),
    expect: [
      /portal\/server\/caller\.ts imports plan-input store platform\/database\/src\/stores\/commitments\.ts but is not a registered writer/
    ]
  },
  {
    name: "an unregistered file that imports a host entry which re-exports a plan-input store",
    files: {
      [`${STORES}commitments.ts`]: sql("UPDATE commitments SET a = 1"),
      [`${PG}commit-writer.ts`]: null,
      "portal/server/host-entry.ts": 'export { run } from "../../platform/database/src/stores/commitments.js";\n',
      "portal/server/caller.ts": 'import { run } from "./host-entry";\nexport { run };\n'
    },
    shards: H(without(baseRows, `${PG}commit-writer.ts`)),
    expect: [/portal\/server\/caller\.ts imports plan-input store platform\/database\/src\/stores\/commitments\.ts/]
  },
  {
    name: "an add-on write-paths.json that owns a core table",
    composed: true,
    files: {
      "addons/notes/server/write-paths.json": {
        owns: { ...ADDON_OWNS.owns, commitments: "addons/notes/server/entries.ts" },
        writers: {}
      }
    },
    expect: [/addons\/notes\/server\/write-paths\.json owns commitments, which is a core table/]
  },
  {
    name: "an add-on owns a table its own drizzle set does not create",
    composed: true,
    files: {
      "addons/notes/server/write-paths.json": {
        owns: { ...ADDON_OWNS.owns, "notes.ghost": "addons/notes/server/entries.ts" },
        writers: {}
      }
    },
    expect: [/owns notes\.ghost, which addons\/notes\/drizzle\/\*\.sql does not create/]
  },
  {
    name: "an add-on table written by two of its files",
    composed: true,
    files: { "addons/notes/server/other.ts": sql("UPDATE notes.entries SET id = 2") },
    expect: [/addons\/notes\/server\/other\.ts writes notes\.entries, which addons\/notes\/server\/entries\.ts owns/]
  },
  {
    name: "an add-on file that writes push_outbox",
    composed: true,
    files: { "addons/notes/server/other.ts": sql("INSERT INTO push_outbox (id) VALUES (1)") },
    expect: [/addons\/notes\/server\/other\.ts writes core table push_outbox/]
  },
  {
    name: "a table an add-on's SQL set creates with no owns row",
    composed: true,
    files: { "addons/notes/drizzle/0002_more.sql": "CREATE TABLE notes.extra (id int);\n" },
    expect: [
      /notes\.extra is created by addons\/notes\/drizzle\/\*\.sql but no write-paths\.json under addons\/notes\/ owns it/
    ]
  },
  {
    name: "an overlay file in a composed tree is skipped, but an add-on write-paths.json with a bad owner file is checked",
    composed: true,
    files: {
      "addons/notes/server/write-paths.json": {
        owns: { ...ADDON_OWNS.owns, notes_tags: "addons/notes/server/missing.ts" },
        writers: {}
      }
    },
    expect: [/owns notes_tags in addons\/notes\/server\/missing\.ts, which does not exist/]
  }
];

// Must-pass cases.
export const PASS = [
  {
    name: "the base tree",
    files: {}
  },
  {
    name: "operations/restore-run.ts writing every table, literally and by name",
    files: {
      [`${OPS}restore-run.ts`]: [
        sql("INSERT INTO commitments (id) VALUES (1)"),
        sql("UPDATE sessions SET a = 1"),
        'export const dyn = (tx, table) => [tx`UPDATE ${tx(table)} SET a = 1`, tx.unsafe(`DELETE FROM "${table}"`), tx.unsafe("DELETE FROM " + table)];\n',
        "export const builder = (db) => db.update(commitments).set({});\n"
      ].join("")
    }
  },
  {
    name: "15 lines of a non-owner's SQL moved into the table's new owner, with the source's row deleted",
    base: {
      [`${PG}commit-writer.ts`]: `${sql("UPDATE commitments SET title = 'x'")}${"// filler\n".repeat(15)}`
    },
    files: {
      [`${PG}commit-writer.ts`]: `export { run } from "../../../../platform/database/src/stores/commitments.js";\n`,
      [`${STORES}commitments.ts`]: `${"// filler\n".repeat(15)}${sql("UPDATE commitments SET title = 'x'")}`
    },
    shards: H(without(baseRows, `${PG}commit-writer.ts`))
  },
  {
    name: "dynamic writes moving between files of one lane, lane total level",
    baseShards: H(baseRows, { [`${PG}dyn.ts`]: 1 }),
    base: { [`${PG}dyn.ts`]: 'export const run = (tx, t) => tx.unsafe("DELETE FROM " + t);\n' },
    files: {
      [`${PG}dyn.ts`]: null,
      [`${PG}row-stores.ts`]: 'export const run = (tx, t) => tx.unsafe("DELETE FROM " + t);\n'
    },
    shards: H(baseRows, { [`${PG}row-stores.ts`]: 1 })
  },
  {
    name: "an unregistered core file importing a non-plan-input store",
    files: {
      [`${STORES}push-outbox.ts`]: sql("INSERT INTO push_outbox (id) VALUES (1)"),
      "portal/server/caller.ts":
        'import { run } from "../../platform/database/src/stores/push-outbox.js";\nexport { run };\n'
    }
  },
  {
    name: "a registered writer importing a plan-input store",
    files: {
      [`${STORES}commitments.ts`]: sql("UPDATE commitments SET a = 1"),
      [`${PG}commit-writer.ts`]: null,
      [`${PG}close-commands.ts`]:
        'import { run } from "../../../../platform/database/src/stores/commitments.js";\nexport const close = recordStateChange(run);\n'
    },
    shards: H(without(baseRows, `${PG}commit-writer.ts`))
  },
  {
    name: "a host entry that re-exports a store",
    files: {
      [`${STORES}commitments.ts`]: sql("UPDATE commitments SET a = 1"),
      [`${PG}commit-writer.ts`]: null,
      "portal/server/host-entry.ts":
        'export { run } from "../../platform/database/src/stores/commitments.js";\nexport * from "../../platform/database/src/stores/commitments.js";\n'
    },
    shards: H(without(baseRows, `${PG}commit-writer.ts`))
  },
  {
    name: "a row for a table that a fixture migration drops",
    base: { "platform/database/drizzle/0002_drop.sql": 'DROP TABLE IF EXISTS "retired_table";\n' },
    registry: { TABLE_OWNERS: { ...REGISTRY.TABLE_OWNERS, retired_table: { owner: `${STORES}retired.ts` } } }
  },
  {
    name: "an owner that does not exist yet while the table's writers are still in a shard",
    files: {}
  },
  {
    name: "an overlay file in a composed fixture tree is not a core writer",
    composed: true,
    syncCore: { overlayFiles: ["portal/server/persistence/postgres/overlay-writer.ts"] },
    files: { [`${PG}overlay-writer.ts`]: sql("UPDATE commitments SET a = 1") }
  },
  {
    name: "an overlay add-on package's write-paths.json in a composed fixture tree, checked and valid",
    composed: true,
    files: {}
  },
  {
    name: "an add-on table schema-qualified in one file and quoted in the owner",
    composed: true,
    files: { "addons/notes/server/entries.ts": sql('INSERT INTO "notes"."entries" (id) VALUES (1)') }
  }
];

// ---- review round: SQL forms the first match missed, and the checks that failed nothing when disabled
const writes = (statement) => ({ [`${PG}new-writer.ts`]: sql(statement) });
for (const statement of [
  "insert into commitments (id) values (1)",
  "TRUNCATE TABLE commitments",
  "truncate commitments restart identity",
  "TRUNCATE TABLE ONLY sessions, commitments CASCADE",
  "INSERT INTO /* c */ commitments (id) VALUES (1)",
  'INSERT INTO "public"."commitments" (id) VALUES (1)',
  "INSERT INTO app.commitments (id) VALUES (1)",
  "MERGE INTO commitments USING x ON true WHEN MATCHED THEN DELETE",
  "update only commitments set a = 1",
  "delete from commitments"
])
  FAIL.push({
    name: `the SQL form ${statement.split(" ").slice(0, 4).join(" ")} is a write`,
    files: writes(statement),
    expect: [/new-writer\.ts writes commitments, which/]
  });
for (const statement of [
  "update ${tx(table)} set a = 1",
  "TRUNCATE TABLE ${table}",
  'INSERT INTO "app".${table} (a) VALUES (1)',
  "INSERT INTO /* c */ ${table} (a) VALUES (1)"
])
  FAIL.push({
    name: `the non-literal form ${statement.split(" ").slice(0, 3).join(" ")} is counted`,
    files: writes(statement),
    expect: [/new-writer\.ts writes a table that is not a literal/]
  });
FAIL.push(
  {
    name: "a lower-case write in an operations/ file that is not listed",
    files: { [`${OPS}lower.ts`]: sql("insert into somewhere (id) values (1)").replace("somewhere", "commitments") },
    expect: [/operations\/lower\.ts writes a table but is not in OPERATIONS_WRITERS/]
  },
  {
    name: "a TRUNCATE in an operations/ file that is not listed",
    files: { [`${OPS}wipe.ts`]: sql("TRUNCATE TABLE commitments") },
    expect: [/operations\/wipe\.ts writes a table but is not in OPERATIONS_WRITERS/]
  },
  {
    name: "a test-harness path listed in TEST_HARNESS_WRITERS that does not exist",
    files: { [`${PG}state-store-harness.ts`]: null },
    expect: [/TEST_HARNESS_WRITERS lists .*state-store-harness\.ts, which does not exist/]
  },
  {
    name: "a file next to the test harness that also truncates is still a writer",
    files: { [`${PG}other-harness.ts`]: sql("TRUNCATE TABLE users, commitments") },
    expect: [/other-harness\.ts writes commitments, which/]
  },
  {
    name: "a rows total that is not the sum of its files",
    shards: { H: { ...BASE_SHARDS.H, rows: { ...BASE_SHARDS.H.rows, total: 5 } } },
    expect: [/H\.json rows: total is 5 but its files add up to 3/]
  },
  {
    name: "a dynamic total that is not the sum of its files",
    baseShards: H(baseRows, { [`${PG}dyn.ts`]: 2 }),
    base: {
      [`${PG}dyn.ts`]: 'export const run = (tx, t) => [tx.unsafe("DELETE FROM " + t), tx.unsafe("UPDATE " + t)];\n'
    },
    shards: {
      H: { ...shardOf("H", baseRows, { [`${PG}dyn.ts`]: 2 }), dynamic: { total: 1, files: { [`${PG}dyn.ts`]: 2 } } }
    },
    expect: [/H\.json dynamic: total is 1 but its files add up to 2/]
  },
  {
    name: "the commit to compare against is missing in CI",
    ci: true,
    files: {},
    expect: [
      /the commit to compare against could not be found, so the set-shrink check cannot run, and CI must not skip it/
    ]
  },
  {
    name: "an empty owner file",
    registry: { TABLE_OWNERS: { ...REGISTRY.TABLE_OWNERS, spans: { owner: "" } } },
    expect: [/TABLE_OWNERS gives spans no owner file/]
  },
  {
    name: "a shard whose lane field is not its file name",
    shards: { H: { ...BASE_SHARDS.H, lane: "W" } },
    expect: [/H\.json says lane "W"; the file name and the lane must match/]
  },
  {
    name: "a shard with an unknown section",
    shards: { H: { ...BASE_SHARDS.H, extras: { total: 0, files: {} } } },
    expect: [/H\.json has an unknown section "extras"; use rows or dynamic/]
  },
  {
    name: "a row listed under the wrong lane",
    shards: {
      H: shardOf("H", without(baseRows, `${PG}entity-commands.ts`)),
      W: shardOf("W", { [`${PG}entity-commands.ts`]: ["spans"] })
    },
    expect: [/W\.json lists .*entity-commands\.ts, which belongs to lane H/]
  },
  {
    name: "OPERATIONS_WRITERS lists a file that does not exist",
    registry: { OPERATIONS_WRITERS: [`${OPS}restore-run.ts`, `${OPS}ghost.ts`] },
    expect: [/OPERATIONS_WRITERS lists .*operations\/ghost\.ts, which does not exist/]
  },
  {
    name: "two add-ons claiming one table",
    composed: true,
    files: {
      "addons/extra/drizzle/0001.sql": "CREATE TABLE notes.entries (id int);\n",
      "addons/extra/server/write-paths.json": { owns: { "notes.entries": "addons/extra/server/x.ts" }, writers: {} },
      "addons/extra/server/x.ts": sql("INSERT INTO notes.entries (id) VALUES (2)")
    },
    expect: [/owns notes\.entries in .*, but .* already owns it/]
  }
);
PASS.push({
  name: "the pinned test harness truncates tables and is not a runtime writer",
  files: {
    [`${PG}state-store-harness.ts`]: sql("TRUNCATE TABLE users, commitments, sessions RESTART IDENTITY CASCADE")
  }
});

export { ADDON_BASE };
