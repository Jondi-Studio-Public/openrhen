// One writer per table (modularity plan W0; metrics S9 and S9d). Every core table (a `pgTable` in
// `platform/database/src/schema/core.ts`) has one owner file, named in `write-path-registry.mjs` `TABLE_OWNERS`, and
// every other module calls that owner's functions. Today most tables have several writers, so the writes that are not
// in the owner are held in per-lane shards, `scripts/repository/pending/write-owners/<lane>.json`, that only shrink:
//   { "lane": "H",
//     "rows":    { "total": 3, "files": { "<file>": ["<table>", ...] } },   (file, table) pairs that are not the owner's
//     "dynamic": { "total": 2, "files": { "<file>": 2 } } }                 writes whose table name is not a literal
// A W slice moves SQL into the table's owner and deletes the rows it makes stale; nothing adds a row.
//
// What counts as a write is a text match, like the one-write-path guard in check-structure.mjs, widened from the 37
// plan-input tables to every core table, to an optional `public.` and quotes, and to `engine/` and `scripts/backup/`:
// `INSERT INTO`, `UPDATE` or `DELETE FROM` a table, in `.ts/.tsx/.mjs` files outside tests, `drizzle/` and
// `*-test-fixtures.ts`. A write whose table position is not a literal (`${...}`, or `"UPDATE " + table`) is counted
// per file; the dynamic counts carry no table, so they may move between the files of one lane but a lane's total
// never rises. `platform/database/src/operations/` is exempt by that exact prefix, with its writer files pinned
// (`OPERATIONS_WRITERS`), and `scripts/backup/record-run.mjs` -> `integration_sync_runs` is the one pinned exemption.
//
// Add-on layer packages (`addons/<id>/<layer>/write-paths.json`, read by `addon-routes.mjs` `loadAddonWriters`) name
// the one file that writes each table their own SQL set creates; that part runs in the composed tree too.
//
// Rule-module convention (see check-structure.mjs): default export `(ctx) => string[]`, ctx = { root, args, base?,
// env?, registry? }. `registry` replaces the exports of write-path-registry.mjs, for the fixtures.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { loadAddonWriters } from "../addon-routes.mjs";
import * as defaultRegistry from "../write-path-registry.mjs";
import {
  baseShards,
  composedSkips,
  hasHead,
  laneOf,
  readJson,
  readShards,
  resolveBase,
  trackedFiles
} from "./vendor-terms.mjs";

const PENDING = "scripts/repository/pending/write-owners";
const LANES_CONFIG = "scripts/repository/rules/vendor-terms.json";
const SCHEMA = "platform/database/src/schema/core.ts";
const OPERATIONS = "platform/database/src/operations/";
const FIX = "run `pnpm structure:check --fix-pending`";

/** The one exemption that may exist: the backup sidecar runs plain node in its own image and cannot import a TS owner. */
const PINNED_EXEMPTION = { file: "scripts/backup/record-run.mjs", table: "integration_sync_runs" };

// The files the match reads: portal, platform, integrations, tools and engine, plus the backup sidecar.
const SCANNED = /^(?:portal|platform|integrations|tools|engine)\/|^scripts\/backup\//;
const SOURCE = /\.(?:ts|tsx|mjs)$/;
const NOT_RUNTIME =
  /\.(?:test|spec)\.[cm]?[jt]sx?$|-test-fixtures\.ts$|\.d\.ts$|(?:^|\/)(?:vitest-[^/]*|[^/]*\.config\.[^/]*)$/;
const NOT_SCANNED =
  /(?:^|\/)(?:node_modules|dist|\.next|\.vinext)\/|^platform\/database\/drizzle\/|^integrations\/addon-example\/overlay\//;
// Lane N (the plan's §3 lanes): the database-side table owners and the other runtime folders of platform/database that
// the shared lane config does not name.
const LANE_N = /^platform\/database\/src\/(?:stores|push|consequence|offer-log)\//;
const laneFor = (config, path) => (LANE_N.test(path) ? "N" : laneOf(config, path));

const KEYWORD = String.raw`(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)`;
const Q = "[\"'`]";
// A write whose table position is an interpolation (quoted or not), or a concatenation (r7: `"${name}"` was missed).
const DYNAMIC = [
  new RegExp(String.raw`\b${KEYWORD}\s+(?:public\.)?${Q}?\s*\$\{`, "g"),
  new RegExp(String.raw`${Q}\s*${KEYWORD}\s*${Q}?\s*\+`, "g")
];
// Operations scripts also write schema-qualified tables outside `public` (the migration journal).
const QUALIFIED = new RegExp(String.raw`\b${KEYWORD}\s+(?!public\.)[a-z_]+\.${Q}?[\w$]`, "g");

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const lineOf = (text, index) => text.slice(0, index).split("\n").length;
const plural = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const sortedUnique = (values) => [...new Set(values)].sort();

function literalPattern(tables) {
  return tables.length === 0
    ? null
    : new RegExp(String.raw`\b${KEYWORD}\s+(?:public\.)?["'\`]?(${tables.map(escape).join("|")})\b`, "g");
}

/** What one file writes: literal core tables, non-literal statements (with their lines), query-builder tables. */
function writesIn(text, literal, builder, camel) {
  const tables = new Set();
  if (literal) for (const match of text.matchAll(literal)) tables.add(match[1]);
  const dynamic = [];
  for (const pattern of DYNAMIC) for (const match of text.matchAll(pattern)) dynamic.push(lineOf(text, match.index));
  const builderTables = new Set();
  if (builder) for (const match of text.matchAll(builder)) builderTables.add(camel.get(match[1]));
  const qualified = [...text.matchAll(QUALIFIED)].length > 0;
  return { tables, dynamic: dynamic.sort((a, b) => a - b), builderTables, qualified };
}

/** `import`/`export ... from` specifiers of a file, with whether each is a re-export. Type-only imports do not run. */
function specifiersOf(text) {
  const found = [];
  for (const match of text.matchAll(/\b(import|export)(\s+type\b)?[^;'"`()]*?\bfrom\s*["']([^"'\n]+)["']/g)) {
    if (match[1] === "import" && match[2]) continue;
    found.push({ specifier: match[3], reexport: match[1] === "export" });
  }
  for (const match of text.matchAll(/\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g))
    found.push({ specifier: match[1], reexport: false });
  for (const match of text.matchAll(/(?:^|\n)\s*import\s*["']([^"'\n]+)["']/g))
    found.push({ specifier: match[1], reexport: false });
  return found;
}

function resolveSpecifier(specifier, from, files) {
  let base;
  if (specifier.startsWith(".")) base = posix.normalize(posix.join(posix.dirname(from), specifier));
  else if (specifier.startsWith("@/")) base = `portal/${specifier.slice(2)}`;
  else if (specifier === "@openrhen/database/stores") base = "platform/database/src/stores/index";
  else if (specifier.startsWith("@openrhen/database/stores/"))
    base = `platform/database/src/stores/${specifier.slice("@openrhen/database/stores/".length)}`;
  else return null;
  const bare = base.replace(/\.(?:m?js|jsx)$/, "");
  for (const candidate of [
    base,
    `${bare}.ts`,
    `${bare}.tsx`,
    `${bare}.mjs`,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`
  ])
    if (files.has(candidate)) return candidate;
  return null;
}

function readShardRows(shard) {
  const rows = new Map();
  for (const [file, tables] of Object.entries(shard?.rows?.files ?? {}))
    for (const table of tables) rows.set(`${file}\0${table}`, { file, table });
  return rows;
}

const dynamicOf = (shard) => shard?.dynamic?.files ?? {};
const dynamicTotal = (shards, lane) => shards?.get(lane)?.dynamic?.total ?? 0;

export default function writeOwners(ctx) {
  const root = ctx.root;
  const args = ctx.args ?? [];
  const registry = { ...defaultRegistry, ...ctx.registry };
  const { TABLE_OWNERS, OPERATIONS_WRITERS, WRITERS, PLAN_INPUT_TABLES } = registry;
  const errors = [];
  if (!existsSync(resolve(root, SCHEMA))) return errors;
  if (!existsSync(resolve(root, LANES_CONFIG)))
    return [`${LANES_CONFIG} is missing. write-owners assigns writes to lanes with it; restore it.`];
  const lanesConfig = readJson(root, LANES_CONFIG);

  const base = resolveBase(root, ctx);
  const ci = ctx.env?.CI ?? process.env.CI;
  if (!base && hasHead(root) && ci)
    errors.push(
      "write-owners: the commit to compare against could not be found, so the set-shrink check cannot run, and CI must not skip it. Fetch more history (for example `fetch-depth: 2` or `git fetch origin main`) or set VENDOR_TERMS_BASE to a commit that exists."
    );

  const schemaText = readFileSync(resolve(root, SCHEMA), "utf8");
  const camel = new Map(
    [...schemaText.matchAll(/export const (\w+) = pgTable\(\s*"([^"]+)"/g)].map((match) => [match[1], match[2]])
  );
  const tables = sortedUnique([...schemaText.matchAll(/pgTable\(\s*"([^"]+)"/g)].map((match) => match[1]));
  const tableSet = new Set(tables);
  const planInput = new Set(PLAN_INPUT_TABLES);
  const literal = literalPattern(tables);
  const builder = camel.size
    ? new RegExp(String.raw`\.(?:insert|update|delete)\(\s*(?:\w+\.)?(${[...camel.keys()].join("|")})\s*[,)]`, "g")
    : null;

  const tracked = trackedFiles(root);
  const fileSet = new Set(tracked);
  const skip = composedSkips(root);
  const isStoreClass = (path) => registeredClass(path) === "store";
  const registeredClass = (path) => {
    for (const [writerPath, entry] of Object.entries(WRITERS))
      if (writerPath.endsWith("/") ? path.startsWith(writerPath) : path === writerPath) return entry.class;
    return null;
  };
  const text = (path) => readFileSync(join(root, path), "utf8");

  // ---- registry against the schema
  const dropped = new Set();
  for (const path of tracked.filter((file) => /^platform\/database\/drizzle\/[^/]+\.sql$/.test(file))) {
    for (const match of text(path).matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:"?public"?\.)?"?(\w+)"?/gi))
      dropped.add(match[1]);
  }
  for (const name of tables)
    if (!(name in TABLE_OWNERS))
      errors.push(
        `${name} is in schema/core.ts but has no TABLE_OWNERS row: add one in scripts/repository/write-path-registry.mjs naming the file that owns its writes (a new table names its owner in the PR that adds it).`
      );
  for (const [name, row] of Object.entries(TABLE_OWNERS)) {
    if (!tableSet.has(name) && !dropped.has(name))
      errors.push(
        `TABLE_OWNERS names ${name}, which is not in schema/core.ts and no migration drops: remove the row from scripts/repository/write-path-registry.mjs.`
      );
    if (row.owner !== null && (typeof row.owner !== "string" || row.owner === ""))
      errors.push(
        `TABLE_OWNERS gives ${name} no owner file; use a repository path, or null for a table no file writes.`
      );
  }

  // ---- exemptions
  const exemptPairs = new Set();
  for (const [name, row] of Object.entries(TABLE_OWNERS)) {
    for (const file of Object.keys(row.exempt ?? {})) {
      if (file === PINNED_EXEMPTION.file && name === PINNED_EXEMPTION.table) exemptPairs.add(`${file}\0${name}`);
      else
        errors.push(
          `TABLE_OWNERS exempts ${file} for ${name}, but the only exemption allowed is ${PINNED_EXEMPTION.file} -> ${PINNED_EXEMPTION.table} (the backup sidecar runs plain node and cannot import a TypeScript owner). Call ${name}'s owner instead.`
        );
    }
  }

  // ---- measure
  const writers = new Map(); // file -> Set(table), outside operations/
  const dynamic = new Map(); // file -> [line]
  const builders = new Map(); // file -> Set(table)
  const operationsWriters = new Set();
  const references = new Map(); // file -> [{target, reexport}]
  const runtime = [];
  for (const path of tracked) {
    if (skip.has(path) || !SCANNED.test(path) || !SOURCE.test(path) || NOT_SCANNED.test(path)) continue;
    if (NOT_RUNTIME.test(path) || !existsSync(join(root, path))) continue;
    runtime.push(path);
    const body = text(path);
    const found = writesIn(body, literal, builder, camel);
    if (path.startsWith(OPERATIONS)) {
      if (found.tables.size || found.dynamic.length || found.builderTables.size || found.qualified)
        operationsWriters.add(path);
    } else {
      if (found.tables.size) writers.set(path, found.tables);
      if (found.dynamic.length) dynamic.set(path, found.dynamic);
      if (found.builderTables.size) builders.set(path, found.builderTables);
    }
    const refs = specifiersOf(body)
      .map(({ specifier, reexport }) => ({ target: resolveSpecifier(specifier, path, fileSet), reexport }))
      .filter((ref) => ref.target);
    if (refs.length) references.set(path, refs);
  }

  const ownerOf = (name) => TABLE_OWNERS[name]?.owner ?? null;
  const ownerText = (name) => {
    const owner = ownerOf(name);
    return owner === null ? "no file (owner: null)" : owner;
  };

  // The pairs the shards must hold: every write whose file is not the table's owner and not the pinned exemption.
  const measured = new Map(); // key -> {file, table}
  for (const [file, written] of writers) {
    for (const name of written) {
      if (!(name in TABLE_OWNERS) || ownerOf(name) === file || exemptPairs.has(`${file}\0${name}`)) continue;
      if (file === PINNED_EXEMPTION.file) {
        errors.push(
          `${file} writes ${name}, but its one exemption covers only ${PINNED_EXEMPTION.table}. Call ${name}'s owner (${ownerText(name)}) instead.`
        );
        continue;
      }
      measured.set(`${file}\0${name}`, { file, table: name });
    }
  }

  // ---- shards
  const lanesOf = (rows) => {
    const byLane = new Map();
    for (const { file, table } of rows.values()) {
      const lane = laneFor(lanesConfig, file);
      if (!byLane.has(lane)) byLane.set(lane, new Map());
      const files = byLane.get(lane);
      files.set(file, [...(files.get(file) ?? []), table]);
    }
    return byLane;
  };
  const measuredLanes = lanesOf(measured);
  const measuredDynamic = new Map(); // lane -> {file: n}
  for (const [file, lines] of dynamic) {
    const lane = laneFor(lanesConfig, file);
    measuredDynamic.set(lane, { ...measuredDynamic.get(lane), [file]: lines.length });
  }

  let shards = readShards(root, PENDING);
  const bShards = base ? baseShards(root, base, PENDING) : null;
  const baseRows = (lane) => readShardRows(bShards?.get(lane));

  if (args.includes("--fix-pending")) {
    const dir = resolve(root, PENDING);
    mkdirSync(dir, { recursive: true });
    for (const lane of new Set([...measuredLanes.keys(), ...measuredDynamic.keys(), ...shards.keys()])) {
      const now = new Map(measuredLanes.get(lane) ?? []);
      const nowDynamic = measuredDynamic.get(lane) ?? {};
      const bootstrap = !bShards && shards.size === 0;
      const allowed = bShards ? baseRows(lane) : readShardRows(shards.get(lane));
      const rows = {};
      for (const [file, list] of now) {
        const kept = list.filter((table) => bootstrap || allowed.has(`${file}\0${table}`)).sort();
        for (const table of list.filter((name) => !kept.includes(name)))
          errors.push(
            `Refusing to add the row ${file} -> ${table} to ${PENDING}/${lane}.json: pending rows only shrink. Call ${table}'s owner (${ownerText(table)}) instead.`
          );
        if (kept.length) rows[file] = kept;
      }
      const dynamicCap = bShards ? dynamicTotal(bShards, lane) : shards.size ? dynamicTotal(shards, lane) : Infinity;
      const dynamicNow = Object.values(nowDynamic).reduce((a, b) => a + b, 0);
      let dynamicFiles = nowDynamic;
      if (dynamicNow > dynamicCap) {
        errors.push(
          `Refusing to raise ${lane} dynamic in ${PENDING} from ${dynamicCap} to ${dynamicNow}: pending counts only shrink. Name the table in a literal, in its owner, or move the write from a file in the same lane.`
        );
        dynamicFiles = dynamicOf(shards.get(lane));
      }
      const next = { lane };
      const sum = (object) => Object.values(object).reduce((a, b) => a + (Array.isArray(b) ? b.length : b), 0);
      const sort = (object) => Object.fromEntries(Object.entries(object).sort(([a], [b]) => (a < b ? -1 : 1)));
      if (Object.keys(rows).length) next.rows = { total: sum(rows), files: sort(rows) };
      if (Object.keys(dynamicFiles).length) next.dynamic = { total: sum(dynamicFiles), files: sort(dynamicFiles) };
      const file = join(dir, `${lane}.json`);
      if (next.rows || next.dynamic) writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
      else rmSync(file, { force: true });
    }
    shards = readShards(root, PENDING);
  }

  // ---- compare the writes with the shards
  const declared = new Map(); // key -> {file, table, lane}
  for (const [lane, shard] of shards) {
    const shardFile = `${PENDING}/${lane}.json`;
    if (shard.lane !== lane)
      errors.push(`${shardFile} says lane "${shard.lane}"; the file name and the lane must match.`);
    for (const key of Object.keys(shard))
      if (!["lane", "rows", "dynamic"].includes(key))
        errors.push(`${shardFile} has an unknown section "${key}"; use rows or dynamic.`);
    const rows = shard.rows?.files ?? {};
    const listed = Object.values(rows).reduce((a, tables) => a + tables.length, 0);
    if (shard.rows && listed !== shard.rows.total)
      errors.push(`${shardFile} rows: total is ${shard.rows.total} but its files add up to ${listed}. ${FIX}.`);
    const dynamicSum = Object.values(dynamicOf(shard)).reduce((a, b) => a + b, 0);
    if (shard.dynamic && dynamicSum !== shard.dynamic.total)
      errors.push(
        `${shardFile} dynamic: total is ${shard.dynamic.total} but its files add up to ${dynamicSum}. ${FIX}.`
      );
    for (const [file, list] of Object.entries(rows)) {
      if (laneFor(lanesConfig, file) !== lane)
        errors.push(
          `${shardFile} lists ${file}, which belongs to lane ${laneFor(lanesConfig, file)}. Move the entry, or ${FIX}.`
        );
      for (const table of list) declared.set(`${file}\0${table}`, { file, table, lane });
    }
  }
  for (const [key, { file, table }] of measured) {
    if (declared.has(key)) continue;
    errors.push(
      `${file} writes ${table}, which ${ownerText(table)} owns (write-path-registry.mjs TABLE_OWNERS): call the owner's function instead of writing the table here.`
    );
  }
  for (const [key, { file, table, lane }] of declared) {
    if (measured.has(key)) continue;
    errors.push(
      `${file} no longer writes ${table}, or ${ownerText(table)} now owns it, so its row is stale: remove ${file} -> ${table} from ${PENDING}/${lane}.json, or ${FIX} (which only deletes rows).`
    );
  }
  if (bShards) {
    for (const [lane] of shards) {
      const before = baseRows(lane);
      for (const [key, { file, table }] of declared) {
        if (declared.get(key).lane === lane && !before.has(key))
          errors.push(
            `${PENDING}/${lane}.json gains the row ${file} -> ${table} against ${base}: pending rows only shrink, and the moved-hits allowance does not apply to rows. Call the owner (${ownerText(table)}) instead of listing the write.`
          );
      }
    }
  }

  // ---- non-literal writes
  for (const lane of new Set([...measuredDynamic.keys(), ...shards.keys()])) {
    const shardFile = `${PENDING}/${lane}.json`;
    const nowFiles = measuredDynamic.get(lane) ?? {};
    const declaredFiles = dynamicOf(shards.get(lane));
    for (const file of new Set([...Object.keys(nowFiles), ...Object.keys(declaredFiles)])) {
      const have = nowFiles[file] ?? 0;
      const allowed = declaredFiles[file] ?? 0;
      const where = (dynamic.get(file) ?? []).join(", ");
      if (have > allowed)
        errors.push(
          `${file} writes a table that is not a literal (${plural(have, "non-literal write")}, line ${where}) but ${shardFile} allows ${allowed}. Name the table in the SQL and call its owner; pending counts never go up. If these writes moved here from another file in lane ${lane} and the lane total did not rise, ${FIX}.`
        );
      else if (have < allowed)
        errors.push(
          `${file} now has ${plural(have, "non-literal write")}, below the ${allowed} in ${shardFile} (the count is stale). Lower it in ${shardFile}, or ${FIX}.`
        );
    }
    if (bShards) {
      const before = dynamicTotal(bShards, lane);
      const after = shards.get(lane)?.dynamic?.total ?? 0;
      if (after > before)
        errors.push(
          `Lane ${lane} dynamic total rises from ${before} (at ${base}) to ${after}. A lane's non-literal writes never rise in a pull request; they may move between files of one lane only if the total stays level.`
        );
    }
  }

  // ---- owners
  const declaredTables = new Set([...declared.values()].map(({ table }) => table));
  for (const [name, row] of Object.entries(TABLE_OWNERS)) {
    if (row.owner === null || !tableSet.has(name) || !existsSync(join(root, row.owner))) continue;
    if (!declaredTables.has(name) && !writers.get(row.owner)?.has(name))
      errors.push(
        `owner ${row.owner} does not write ${name} (write-path-registry.mjs TABLE_OWNERS), and no shard row for ${name} is left: the SQL for ${name} belongs in ${row.owner}, or the row names another file.`
      );
  }
  const byOwner = new Map();
  for (const [name, row] of Object.entries(TABLE_OWNERS))
    if (row.owner) byOwner.set(row.owner, [...(byOwner.get(row.owner) ?? []), name]);
  for (const [owner, owned] of byOwner) {
    const inputs = owned.filter((name) => planInput.has(name));
    const others = owned.filter((name) => !planInput.has(name));
    if (inputs.length && others.length)
      errors.push(
        `${owner} owns both plan-input table(s) ${inputs.join(", ")} and non-plan-input table(s) ${others.join(", ")}: split them across owners, because a store that owns a plan-input table may be called only from a registered writer.`
      );
  }
  for (const [file, written] of builders) {
    for (const name of written)
      if (ownerOf(name) !== file)
        errors.push(
          `${file} writes ${name} through the query builder, which ${ownerText(name)} owns (write-path-registry.mjs TABLE_OWNERS): call the owner's function instead.`
        );
  }

  // ---- operations/
  for (const file of OPERATIONS_WRITERS)
    if (!existsSync(join(root, file))) errors.push(`OPERATIONS_WRITERS lists ${file}, which does not exist.`);
  const operationsListed = new Set(OPERATIONS_WRITERS);
  for (const file of operationsWriters)
    if (!operationsListed.has(file))
      errors.push(
        `${file} writes a table but is not in OPERATIONS_WRITERS (write-path-registry.mjs): operations/ is exempt only for the files listed there. Put the SQL in the table's owner, or list the file if it is a backup, restore, migration or seed script.`
      );
  for (const file of runtime) {
    if (file.startsWith(OPERATIONS)) continue;
    for (const { target } of references.get(file) ?? [])
      if (operationsListed.has(target))
        errors.push(
          `${file} imports ${target}, which is in OPERATIONS_WRITERS: a runtime file may not reach the operations/ exemption. Call the table's owner instead.`
        );
  }

  // ---- a store that owns a plan-input table is called only from a registered writer
  const stores = new Set(
    [...byOwner]
      .filter(([owner, owned]) => isStoreClass(owner) && owned.some((name) => planInput.has(name)))
      .map(([owner]) => owner)
  );
  if (stores.size) {
    const importers = new Map(); // target -> [{file, reexport}]
    for (const [file, refs] of references)
      for (const { target, reexport } of refs)
        importers.set(target, [...(importers.get(target) ?? []), { file, reexport }]);
    for (const store of stores) {
      const seen = new Set([store]);
      const reported = new Set();
      const queue = [{ target: store, via: null }];
      while (queue.length) {
        const { target, via } = queue.shift();
        const byFile = new Map();
        for (const { file, reexport } of importers.get(target) ?? [])
          byFile.set(file, (byFile.get(file) ?? true) && reexport);
        for (const [file, onlyReexport] of byFile) {
          if (onlyReexport) {
            // A module whose only reference to the store is an `export ... from` is transparent: its importers count.
            if (!seen.has(file)) {
              seen.add(file);
              queue.push({ target: file, via: via ?? file });
            }
          } else if (registeredClass(file) === null && !reported.has(file)) {
            reported.add(file);
            errors.push(
              `${file} imports plan-input store ${store}${via ? ` (through ${via})` : ""} but is not a registered writer: a store that owns a plan-input table is called only from a registered writer (owner, helper, write-back, retention, bootstrap or store in write-path-registry.mjs), so the change is logged and a recalculation enqueued.`
            );
          }
        }
      }
    }
  }

  errors.push(...addonHook({ root, tracked, tableSet, text }));
  return [...new Set(errors)];
}

/**
 * The add-on writer hook. Unlike every core rule this reads the overlay's add-on packages (`addons/<id>/<layer>/`)
 * even in a composed tree, because openrhen has no `addons/` package of its own. It fails when an `owns` table is a
 * core table, is not created by that add-on's `addons/<id>/drizzle/*.sql`, or is written by another file under
 * `addons/**`; when a table such a set creates has no `owns` row; and when a file under `addons/**` writes a core table.
 */
function addonHook({ root, tracked, tableSet, text }) {
  const errors = [];
  const files = tracked.filter((path) => path.startsWith("addons/"));
  if (files.length === 0) return errors;
  const { owns } = loadAddonWriters(root);

  // Tables each add-on's SQL set creates, keyed `schema.name` (or `name` for the default schema).
  const created = new Map(); // addon id -> Set(key)
  for (const path of files) {
    const match = /^addons\/([^/]+)\/drizzle\/[^/]+\.sql$/.exec(path);
    if (!match) continue;
    const keys = created.get(match[1]) ?? new Set();
    for (const create of text(path).matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?(\w+)"?\.)?"?(\w+)"?/gi))
      keys.add(create[1] && create[1] !== "public" ? `${create[1]}.${create[2]}` : create[2]);
    created.set(match[1], keys);
  }

  const ownerOfKey = new Map(); // key -> owner file
  const ownedBy = new Map(); // addon id -> Set(key)
  for (const row of owns) {
    const key = row.table.replace(/^public\./, "");
    const set = created.get(row.addon) ?? new Set();
    if (tableSet.has(key)) {
      errors.push(
        `${row.file} owns ${row.table}, which is a core table: core tables are owned in write-path-registry.mjs TABLE_OWNERS, and an add-on owns only the tables its own SQL set creates.`
      );
      continue;
    }
    if (!set.has(key)) {
      errors.push(
        `${row.file} owns ${row.table}, which addons/${row.addon}/drizzle/*.sql does not create: an add-on owns only its own tables.`
      );
      continue;
    }
    if (!files.includes(row.owner)) {
      errors.push(`${row.file} owns ${row.table} in ${row.owner}, which does not exist.`);
      continue;
    }
    if (ownerOfKey.has(key) && ownerOfKey.get(key) !== row.owner)
      errors.push(`${row.file} owns ${row.table} in ${row.owner}, but ${ownerOfKey.get(key)} already owns it.`);
    ownerOfKey.set(key, row.owner);
    ownedBy.set(row.addon, (ownedBy.get(row.addon) ?? new Set()).add(key));
  }
  for (const [addon, keys] of created)
    for (const key of keys)
      if (!ownedBy.get(addon)?.has(key))
        errors.push(
          `${key} is created by addons/${addon}/drizzle/*.sql but no write-paths.json under addons/${addon}/ owns it: add "owns": {"${key}": "<the one file that writes it>"} to the layer package that writes it.`
        );

  const keyPattern = (key) => {
    const [first, second] = key.includes(".") ? key.split(".") : [null, key];
    const name = first
      ? String.raw`"?${escape(first)}"?\."?${escape(second)}"?`
      : String.raw`(?:public\.)?"?${escape(second)}"?`;
    return new RegExp(String.raw`\b${KEYWORD}\s+${name}\b`);
  };
  const addonKeys = [...created.values()].flatMap((keys) => [...keys]);
  const addonPatterns = addonKeys.filter((key) => ownerOfKey.has(key)).map((key) => [key, keyPattern(key)]);
  const corePattern = literalPattern([...tableSet]);
  for (const path of files) {
    if (!SOURCE.test(path) || NOT_RUNTIME.test(path) || /^addons\/[^/]+\/drizzle\//.test(path)) continue;
    const body = text(path);
    for (const name of sortedUnique(corePattern ? [...body.matchAll(corePattern)].map((match) => match[1]) : []))
      errors.push(
        `${path} writes core table ${name}: an add-on writes a core table only through the host's store, never in its own SQL (S6 for add-on packages).`
      );
    for (const [key, pattern] of addonPatterns)
      if (pattern.test(body) && ownerOfKey.get(key) !== path)
        errors.push(
          `${path} writes ${key}, which ${ownerOfKey.get(key)} owns (its write-paths.json): call the owner's function instead.`
        );
  }
  return errors;
}
