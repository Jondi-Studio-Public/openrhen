// Shared machinery for the shared-state ratchets (modularity plan A2): side-effect-imports (S1), env-readers (S4) and
// module-state (S5, S5b). Not a rule itself (it sits beside check-structure.mjs, outside rules/, so the rule loader never loads it).
//
// Each rule is an AST rule over one parse of every maintained source file (scripts/repository/rules/ast.mjs, the one
// parser wrapper). It counts hits per file, and holds each count at or below a per-lane "pending" shard
// (scripts/repository/pending/<rule>/<lane>.json), exactly as vendor-terms.mjs does for vendor terms:
//   - a file's count never rises, and a stale (too-high) count fails, so the shards only shrink;
//   - a lane total never rises against the merge-base, so hits may move to a new file in the same lane (a rename, a
//     copy or a split) and nowhere else;
//   - `pnpm structure:check --fix-pending` rewrites the shards to the measured counts and refuses to raise any;
//   - in a tree with no HEAD (the composed core-plus-overlay tree, the add-on conformance copy) the files listed in
//     .sync-core.json as overlay, patched or generated are skipped, and files are read from disk.
// The lane assignment, the tracked-file listing, the base-commit lookup and the shard readers are vendor-terms.mjs's.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { lineOf, parse } from "./rules/ast.mjs";
import {
  baseShards,
  composedSkips,
  hasHead,
  laneOf,
  readJson,
  readShards,
  resolveBase,
  totalOf,
  trackedFiles
} from "./rules/vendor-terms.mjs";

const LANES_CONFIG = "scripts/repository/rules/vendor-terms.json";
const FIX = "run `pnpm structure:check --fix-pending`";

// The roots the shared-state rules read (the plan's A.4 file list), and what they never read.
const ROOTS = /^(?:engine|platform|portal|integrations|tools)\//;
const SOURCE = /\.(?:ts|tsx|mjs)$/;
const GENERATED = /(?:^|\/)(?:node_modules|dist|\.next|\.vinext)\/|\.d\.ts$/;
const TEST_PATH = /\.(?:test|spec)\.|(?:^|\/)(?:test|tests|__tests__)\//;
// Build-tool configs and test setup files count as tests (S4): *.config.ts, vitest-*.ts.
const TEST_NAME = /(?:^|\/)(?:vitest-[^/]*|[^/]*\.config\.[^/]*)$/;
// Portal client code is SYS-19 (out of scope for S4 and S5); page and layout files are client-rendered entry points.
const CLIENT_DIRS = /^portal\/(?:features|shared|components|state)\//;
const PAGE_FILES = /(?:^|\/)(?:page|layout)\.tsx?$/;

/** A source file the shared-state rules look at at all (before the test-support check, which needs its imports). */
export function isMaintainedSource(path) {
  return (
    ROOTS.test(path) && SOURCE.test(path) && !GENERATED.test(path) && !TEST_PATH.test(path) && !TEST_NAME.test(path)
  );
}

/** Server-side files: the maintained sources minus the portal client folders and the page and layout files. */
export const isServerSide = (path) => !CLIENT_DIRS.test(path) && !PAGE_FILES.test(path);

/** Test support is any file that imports vitest (a harness such as state-store-harness.ts). */
export function importsVitest(body) {
  return body.some(
    (statement) => statement.type === "ImportDeclaration" && /^(?:vitest|@vitest\/)/.test(statement.source.value)
  );
}

// The functions that read the connection registry (platform/contracts/src/connections/registry.ts), and the activity
// source readers (platform/contracts/src/activity-events.ts). A module-level const filled from a call to one of these
// is a snapshot taken at import time, which misses everything registered afterwards (S5b). A test pins this list to
// the registry's exports. Later registries (A3's createRegistry) add their readers here.
export const REGISTRY_READERS = [
  "connectionRegistry",
  "connectionManifest",
  "isRegisteredConnection",
  "calendarSourceConnections",
  "intervalCalendarSourceIds",
  "defaultCalendarSyncProviderIds",
  "calendarSinkConnection",
  "calendarSinkLabel",
  "primarySourceConnection",
  "primarySourceIds",
  "primarySourceLabel",
  "calendarSourceIds",
  "reviewCalendarSourceIds",
  "relationshipPrefixOf",
  "sourceRoleOf",
  "sourceLabel",
  "resolveConnection",
  "activitySourceNames",
  "activitySourceEntry",
  "isKnownActivitySource"
];

// Core objects a registry extends at run time: Object.keys/values/entries of one at module level misses the additions.
export const EXTENDED_OBJECTS = ["ACTIVITY_SOURCES"];

/** The one place per process that may read env: the config modules (S4). */
export const CONFIG_MODULES = [
  "portal/server/host/config.ts",
  "engine/worker/src/config.ts",
  "integrations/outbound-proxy/src/host/env.ts",
  "tools/cli/src/config.ts",
  "engine/service/src/config.ts",
  "platform/database/src/config.ts"
];

const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const unwrap = (node) => {
  let current = node;
  while (
    current &&
    (current.type === "ParenthesizedExpression" ||
      current.type === "TSNonNullExpression" ||
      current.type === "TSAsExpression" ||
      current.type === "TSSatisfiesExpression")
  )
    current = current.expression;
  return current;
};

/**
 * Visit every node that runs when the module loads: the top-level statements, including class bodies' static
 * initialisers only through their expressions, but not the bodies of functions, except an immediately invoked one.
 * visit(node, parent) may return false to skip a node's children.
 */
export function walkModuleLoad(statements, visit) {
  const invoked = new Set();
  const go = (node, parent) => {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "CallExpression") {
      const callee = unwrap(node.callee);
      if (callee && FUNCTIONS.has(callee.type)) invoked.add(callee);
    }
    if (FUNCTIONS.has(node.type) && !invoked.has(node)) return;
    if (visit(node, parent) === false) return;
    for (const key of Object.keys(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      const value = node[key];
      if (Array.isArray(value)) for (const child of value) go(child, node);
      else if (value && typeof value === "object") go(value, node);
    }
  };
  for (const statement of statements) go(statement, null);
}

/**
 * Run one ratchet.
 *   rule      the rule's name: its shards are scripts/repository/pending/<rule>/<lane>.json
 *   metrics   { key: { noun, advice } }: the section of a shard, what one hit is called, and the exact next step
 *   measure   ({ path, parsed, server }) => { key: [{ line, what }] } for one file that is not test support
 */
export function astRatchet(ctx, { rule, metrics, measure }) {
  const root = ctx.root;
  const args = ctx.args ?? [];
  const pending = `scripts/repository/pending/${rule}`;
  const keys = Object.keys(metrics);
  const errors = [];
  if (!existsSync(resolve(root, LANES_CONFIG)))
    return [`${LANES_CONFIG} is missing. ${rule} assigns hits to lanes with it; restore it.`];
  const lanesConfig = readJson(root, LANES_CONFIG);

  const base = resolveBase(root, ctx);
  const head = hasHead(root);
  const ci = ctx.env?.CI ?? process.env.CI;
  if (!base && head && ci) {
    errors.push(
      `${rule}: the commit to compare against could not be found, so the lane-total check cannot run, and CI must not skip it. Fetch more history (for example \`fetch-depth: 2\` or \`git fetch origin main\`) or set VENDOR_TERMS_BASE to a commit that exists.`
    );
  }

  // ---- measure
  const skip = composedSkips(root);
  const counts = Object.fromEntries(keys.map((key) => [key, new Map()]));
  const hits = Object.fromEntries(keys.map((key) => [key, new Map()]));
  for (const path of trackedFiles(root)) {
    if (skip.has(path) || !isMaintainedSource(path)) continue;
    let parsed;
    try {
      parsed = parse(join(root, path));
    } catch (error) {
      errors.push(`${rule}: ${error.message}`);
      continue;
    }
    if (importsVitest(parsed.body)) continue;
    const found = measure({ path, parsed, server: isServerSide(path) });
    for (const key of keys) {
      const list = (found[key] ?? []).map((hit) => ({ ...hit, line: hit.line ?? lineOf(parsed.source, hit) }));
      if (list.length === 0) continue;
      counts[key].set(path, list.length);
      hits[key].set(path, list);
    }
  }

  // ---- shards by lane
  const measured = new Map();
  for (const key of keys) {
    for (const [path, n] of counts[key]) {
      const lane = laneOf(lanesConfig, path);
      const shard = measured.get(lane) ?? { lane };
      const section = shard[key] ?? { total: 0, files: {} };
      section.files[path] = n;
      section.total += n;
      shard[key] = section;
      measured.set(lane, shard);
    }
  }
  for (const shard of measured.values()) {
    for (const key of keys) {
      if (shard[key])
        shard[key].files = Object.fromEntries(Object.entries(shard[key].files).sort(([a], [b]) => (a < b ? -1 : 1)));
    }
  }
  const order = (shard) => ({
    lane: shard.lane,
    ...Object.fromEntries(keys.filter((key) => shard[key]).map((key) => [key, shard[key]]))
  });

  let shards = readShards(root, pending);
  const bShards = base ? baseShards(root, base, pending) : null;

  if (args.includes("--fix-pending")) {
    const cap = (lane, key) =>
      bShards ? totalOf(bShards, lane, key) : shards.size ? totalOf(shards, lane, key) : Infinity;
    const dir = resolve(root, pending);
    mkdirSync(dir, { recursive: true });
    for (const lane of new Set([...measured.keys(), ...shards.keys()])) {
      const next = { lane };
      const old = shards.get(lane) ?? {};
      for (const key of keys) {
        const now = measured.get(lane)?.[key];
        if (now && now.total > cap(lane, key)) {
          errors.push(
            `Refusing to raise ${lane}/${key} in ${pending} from ${cap(lane, key)} to ${now.total}: pending counts only shrink. ${metrics[key].advice} Or move the hits from a file in the same lane.`
          );
          if (old[key]) next[key] = old[key];
        } else if (now) next[key] = now;
      }
      const file = join(dir, `${lane}.json`);
      if (keys.some((key) => next[key])) writeFileSync(file, `${JSON.stringify(order(next), null, 2)}\n`);
      else rmSync(file, { force: true });
    }
    shards = readShards(root, pending);
  }

  // ---- compare
  for (const [lane, shard] of shards) {
    if (shard.lane !== lane)
      errors.push(`${pending}/${lane}.json says lane "${shard.lane}"; the file name and the lane must match.`);
    for (const key of Object.keys(shard)) {
      if (key !== "lane" && !keys.includes(key))
        errors.push(`${pending}/${lane}.json has an unknown section "${key}"; use one of ${keys.join(", ")}.`);
    }
  }
  for (const lane of [...new Set([...measured.keys(), ...shards.keys()])].sort()) {
    const shardFile = `${pending}/${lane}.json`;
    for (const key of keys) {
      const { noun, advice } = metrics[key];
      const now = measured.get(lane)?.[key];
      const declared = shards.get(lane)?.[key];
      const nowFiles = now?.files ?? {};
      const declaredFiles = declared?.files ?? {};
      if (declared) {
        const sum = Object.values(declaredFiles).reduce((a, b) => a + b, 0);
        if (sum !== declared.total)
          errors.push(`${shardFile} ${key}: total is ${declared.total} but its files add up to ${sum}. ${FIX}.`);
      }
      for (const path of new Set([...Object.keys(nowFiles), ...Object.keys(declaredFiles)])) {
        const have = nowFiles[path] ?? 0;
        const allowed = declaredFiles[path] ?? 0;
        const plural = (n) => `${n} ${noun}${n === 1 ? "" : "s"}`;
        const lines = [...new Set((hits[key].get(path) ?? []).map((hit) => hit.line))];
        const where = lines.length === 1 ? `line ${lines[0]}` : `lines ${lines.join(", ")}`;
        const what = [...new Set((hits[key].get(path) ?? []).map((hit) => hit.what))].slice(0, 3).join("; ");
        if (have > allowed && allowed === 0) {
          errors.push(
            `${path} is new (or newly) holding ${plural(have)} (${where}: ${what}). ${advice} If these hits moved here from another file in lane ${lane} and the lane total did not rise, ${FIX}.`
          );
        } else if (have > allowed) {
          errors.push(
            `${path} has ${plural(have)} (${where}: ${what}) but ${shardFile} allows ${allowed}. Remove the new ones: ${advice} Pending counts never go up.`
          );
        } else if (have < allowed) {
          errors.push(
            `${path} now has ${plural(have)}, below the ${allowed} in ${shardFile} (the count is stale). Lower ${path} to ${have} in ${shardFile}, or ${FIX}.`
          );
        }
        if (declaredFiles[path] !== undefined && laneOf(lanesConfig, path) !== lane)
          errors.push(
            `${shardFile} lists ${path}, which belongs to lane ${laneOf(lanesConfig, path)}. Move the entry, or ${FIX}.`
          );
      }
      if (bShards) {
        const before = totalOf(bShards, lane, key);
        const after = declared?.total ?? 0;
        if (after > before)
          errors.push(
            `Lane ${lane} ${key} total rises from ${before} (at ${base}) to ${after}. A lane total never rises in a pull request. Hits may move to a new file in the same lane only if the total stays level; otherwise remove them. ${advice}`
          );
      }
    }
  }
  return [...new Set(errors)];
}
