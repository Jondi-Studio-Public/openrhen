// Vendor-term ratchet (modularity plan A1; metrics V1-V4 and V11). Core names no provider a deployment chooses and no
// owner, so this rule counts every vendor term in the tracked text files core owns and holds each count at or below a
// per-lane "pending" shard (scripts/repository/pending/vendor-terms/<lane>.json). The shards only shrink, and at zero
// they are deleted.
//
// Rule-module convention (see check-structure.mjs): the default export is `(ctx) => string[]` where
// ctx = { root, args, base?, env? } and each returned string is one failure.
//
// What is counted (all over text files only, the way `git grep -I` reads them):
//   terms     provider terms, wider vendor words and capitalised vendor words (V1)
//   agents    agent-client terms (V2)
//   owner     owner terms (the personal instance's names)
//   paths     tracked paths whose name holds a provider term or wider vendor word (V3)
//   schema    non-comment lines of the current schema file that hold a term (V4)
//   defaults  literals that only fit one provider (V11)
// The term sets live in rules/vendor-terms.json and may only grow. The platform and interop strings that cannot be
// reworded are the closed table rules/platform-tokens.json.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const CONFIG = "scripts/repository/rules/vendor-terms.json";
const TOKENS = "scripts/repository/rules/platform-tokens.json";
const PENDING = "scripts/repository/pending/vendor-terms";
const METRICS = ["terms", "agents", "owner", "paths", "schema", "defaults"];
const FIX = "run `pnpm structure:check --fix-pending`";
const ADDON_DOC = "docs/architecture/writing-an-addon.md";

export const git = (root, args, options = {}) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1 << 30,
    stdio: ["ignore", "pipe", "ignore"],
    ...options
  });
export const gitOk = (root, args) => {
  try {
    return git(root, args);
  } catch {
    return null;
  }
};
export const readJson = (root, file) => JSON.parse(readFileSync(resolve(root, file), "utf8"));
const sha256 = (text) => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
export const isTest = (path) => /\.test\.|\/test\//.test(path);

function expandBraces(glob) {
  const match = /\{([^{}]*)\}/.exec(glob);
  if (!match) return [glob];
  return match[1]
    .split(",")
    .flatMap((part) => expandBraces(glob.slice(0, match.index) + part + glob.slice(match.index + match[0].length)));
}
// `**/` = any folders (or none), `**` = anything, `*` = anything but "/", `{a,b}` = alternatives.
export function globToRegExp(glob) {
  const sources = expandBraces(glob).map((one) => {
    let out = "";
    for (let i = 0; i < one.length; i++) {
      if (one.startsWith("**/", i)) {
        out += "(?:.*/)?";
        i += 2;
      } else if (one.startsWith("**", i)) {
        out += ".*";
        i += 1;
      } else if (one[i] === "*") out += "[^/]*";
      else out += one[i].replace(/[.+^$()|[\]\\?]/g, "\\$&");
    }
    return out;
  });
  return new RegExp(`^(?:${sources.join("|")})$`);
}
const matcher = (globs = []) => {
  const regexps = globs.map(globToRegExp);
  return (path) => regexps.some((regexp) => regexp.test(path));
};

export function buildPatterns(config) {
  const t = config.terms;
  const wider = Object.values(t.wider).flat();
  return {
    terms: new RegExp(`${t.provider.join("|")}|\\b(?:${wider.join("|")})\\b`, "gi"),
    capitalised: new RegExp(`\\b(?:${t.capitalised.join("|")})\\b`, "g"),
    agents: new RegExp(`${t.agents.substring.join("|")}|\\b(?:${t.agents.word.join("|")})\\b`, "gi"),
    owner: new RegExp(t.owner.join("|"), "gi"),
    path: new RegExp(`${t.provider.join("|")}|\\b(?:${[...wider, ...t.pathWords].join("|")})\\b`, "i")
  };
}

export function laneOf(config, path) {
  for (const { lane, globs } of config.lanes) if (matcher(globs)(path)) return lane;
  return config.fallbackLane;
}

const WALK_SKIPPED = new Set([".git", ".env", "node_modules", ".vinext", "dist", "var", "coverage"]);

// The tracked files; in a scratch tree that is not a git repository (the add-on conformance copy, a source archive)
// every file on disk outside the usual build and dependency folders.
export function trackedFiles(root) {
  try {
    return git(root, ["ls-files", "-z"]).split("\0").filter(Boolean);
  } catch {
    const out = [];
    const walk = (dir) => {
      for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        if (WALK_SKIPPED.has(entry.name) || entry.name.endsWith(".tsbuildinfo")) continue;
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(rel);
        else if (entry.isFile()) out.push(rel);
      }
    };
    walk("");
    return out.sort();
  }
}

export function hasHead(root) {
  return gitOk(root, ["rev-parse", "--verify", "-q", "HEAD"]) !== null;
}

// The commit the PR is measured against: an explicit ctx.base or $VENDOR_TERMS_BASE, else the merge-base with
// origin/main, else the first parent (CI checks a pull request out as a merge commit). null = nothing to compare to.
export function resolveBase(root, ctx = {}) {
  const explicit = ctx.base ?? ctx.env?.VENDOR_TERMS_BASE ?? process.env.VENDOR_TERMS_BASE;
  if (explicit) return gitOk(root, ["rev-parse", "--verify", "-q", `${explicit}^{commit}`]) === null ? null : explicit;
  if (!hasHead(root)) return null;
  const mergeBase = gitOk(root, ["merge-base", "HEAD", "origin/main"])?.trim();
  if (mergeBase) return mergeBase;
  return gitOk(root, ["rev-parse", "--verify", "-q", "HEAD^1"])?.trim() || null;
}

export function showAtBase(root, base, file) {
  return gitOk(root, ["show", `${base}:${file}`]);
}

export function readShards(root, pending = PENDING) {
  const dir = resolve(root, pending);
  const shards = new Map();
  if (!existsSync(dir)) return shards;
  for (const name of readdirSync(dir).sort()) {
    if (name.endsWith(".json")) shards.set(name.slice(0, -5), JSON.parse(readFileSync(join(dir, name), "utf8")));
  }
  return shards;
}

export function baseShards(root, base, pending = PENDING) {
  const listed = gitOk(root, ["ls-tree", "-r", "--name-only", base, "--", pending]);
  if (listed === null || !listed.trim()) return null; // the rule did not exist at the base: bootstrap
  const shards = new Map();
  for (const file of listed.split("\n").filter((line) => line.endsWith(".json"))) {
    shards.set(file.split("/").pop().slice(0, -5), JSON.parse(showAtBase(root, base, file)));
  }
  return shards;
}

export const totalOf = (shards, lane, metric) => shards?.get(lane)?.[metric]?.total ?? 0;

export function composedSkips(root) {
  const skip = new Set();
  if (hasHead(root) || !existsSync(resolve(root, ".sync-core.json"))) return skip;
  const sync = readJson(root, ".sync-core.json");
  skip.add(".sync-core.json");
  for (const key of ["overlayFiles", "patchedFiles", "generatedFiles"]) {
    const value = sync[key];
    if (Array.isArray(value)) value.forEach((file) => skip.add(file));
    else if (value && typeof value === "object") Object.keys(value).forEach((file) => skip.add(file));
  }
  return skip;
}

function maskTokens(path, text, rows) {
  let masked = text;
  for (const row of rows.filter((entry) => entry.path === path)) {
    for (const string of [...row.strings].sort((a, b) => b.length - a.length)) masked = masked.split(string).join(" ");
  }
  return masked;
}

const countMatches = (text, regexp) => text.match(regexp)?.length ?? 0;
const samplesOf = (text, regexp) =>
  [...new Set((text.match(regexp) ?? []).map((word) => word.toLowerCase()))].slice(0, 4);

// Measure the whole tree. Returns { counts: {metric: Map(path -> n)}, samples: Map(path -> words), errors }.
export function measure(root, config, tokenRows, { skip = new Set() } = {}) {
  const patterns = buildPatterns(config);
  const ex = config.exclusions;
  const isOwn = matcher([...ex.own.paths, ...ex.own.globs]);
  const isHistory = matcher(ex.history.globs);
  const isAppliedGlob = matcher(ex.snapshots);
  const historyPaths = new Set(ex.history.paths);
  const migrationEntries = new Map(ex.migrations.map((entry) => [entry.path, entry]));
  const legalEntries = new Map(ex.legal.map((entry) => [entry.path, entry]));
  const archiveEntries = new Map(ex.archive.map((entry) => [entry.path, entry]));
  const historyTests = new Set(ex.migrationHistoryTests);
  const archivePrefix = ex.archivePrefix;
  const pathExempt = new Set(tokenRows.filter((row) => row.pathToo).map((row) => row.path));
  const schemaFiles = new Set(config.schema.files);
  const counts = Object.fromEntries(METRICS.map((metric) => [metric, new Map()]));
  const samples = new Map();
  const errors = [];
  const files = trackedFiles(root);
  const seen = new Set(files);

  for (const [kind, entries] of [
    ["migration", migrationEntries],
    ["legal file", legalEntries],
    ["archive file", archiveEntries]
  ]) {
    for (const [path] of entries) {
      if (!seen.has(path)) {
        errors.push(
          `vendor-terms.json lists the ${kind} ${path}, which is not tracked. Remove its entry from exclusions in ${CONFIG}.`
        );
      }
    }
  }

  const add = (metric, path, n) => {
    if (n > 0) counts[metric].set(path, (counts[metric].get(path) ?? 0) + n);
  };

  for (const path of files) {
    if (skip.has(path) || isOwn(path)) continue;
    const migration = /^platform\/database\/drizzle\/(\d{4})_[^/]*\.sql$/.exec(path);
    const migrationNumber = migration ? Number(migration[1]) : null;
    const pathInHistory =
      historyPaths.has(path) ||
      isHistory(path) ||
      isAppliedGlob(path) ||
      (migrationNumber !== null && migrationNumber <= ex.lastAppliedMigration);
    if (!pathInHistory && !pathExempt.has(path) && patterns.path.test(path)) add("paths", path, 1);

    if (historyPaths.has(path) || isHistory(path) || isAppliedGlob(path) || historyTests.has(path)) continue;
    let buffer;
    try {
      buffer = readFileSync(resolve(root, path));
    } catch {
      continue;
    }
    if (buffer.subarray(0, 8000).includes(0)) continue; // binary: `git grep -I` skips it
    const text = buffer.toString("utf8");

    const frozen = migrationEntries.get(path) ?? archiveEntries.get(path);
    if (frozen) {
      if (sha256(text) !== frozen.sha256) {
        errors.push(
          `${path} is an exempt, frozen file and its content changed. Applied migrations and the archive are history: do not edit them. If a migration really must change, add a new migration instead.`
        );
      }
      continue;
    }
    if (migrationNumber !== null) {
      // Applied migrations are listed with their hashes above; a later migration may name a vendor identifier only on a
      // RENAME or DROP line (A7's copy-then-drop statement is added to this rule by A7).
      const lines = text.split("\n");
      lines.forEach((line, index) => {
        // Comments never exempt anything. Only the RENAME or DROP statement itself (with the table it alters) is exempt;
        // a vendor term elsewhere on the same line still counts.
        const code = line
          .replace(/\/\*.*?\*\//g, " ")
          .replace(/--.*$/, "")
          .replace(/(?:ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?\S+\s+)?\b(?:RENAME|DROP)\b[^;]*;?/gi, " ");
        const hit = countMatches(code, patterns.terms) + countMatches(code, patterns.capitalised);
        if (hit)
          errors.push(
            `${path}:${index + 1} names a vendor (${samplesOf(code, patterns.terms).join(", ")}) outside a RENAME or DROP statement. A migration may mention a vendor-named object only to rename or drop it (a comment does not count). Use a neutral name, or see ${ADDON_DOC}.`
          );
      });
      continue;
    }
    if (archivePrefix && path.startsWith(archivePrefix)) {
      const hit =
        countMatches(text, patterns.terms) +
        countMatches(text, patterns.capitalised) +
        countMatches(text, patterns.agents);
      if (hit)
        errors.push(
          `${path} is under ${archivePrefix} and names a vendor, but the archive is frozen at the files listed in exclusions.archive of ${CONFIG}. Moving a document there does not launder it: reword it or move it to an add-on (${ADDON_DOC}).`
        );
      continue;
    }

    const masked = maskTokens(path, text, tokenRows);
    const termWords = samplesOf(masked, patterns.terms).concat(samplesOf(masked, patterns.capitalised));
    add("terms", path, countMatches(masked, patterns.terms) + countMatches(masked, patterns.capitalised));
    add("agents", path, countMatches(masked, patterns.agents));
    if (!legalEntries.has(path)) add("owner", path, countMatches(masked, patterns.owner));
    else if (sha256(text) !== legalEntries.get(path).sha256) {
      errors.push(
        `${path} is a legal or governance file that must name the owner, exempt by exact content hash, and its content changed. Update its sha256 in exclusions.legal of ${CONFIG} on purpose, in a change a reviewer will see.`
      );
    }
    for (const defaults of config.defaults) {
      if (defaults.skipTests && isTest(path)) continue;
      if (defaults.skipExtensions?.some((extension) => path.endsWith(extension))) continue;
      if (defaults.countBy === "line") {
        const first = new RegExp(defaults.pattern);
        const also = defaults.alsoOnLine ? new RegExp(defaults.alsoOnLine, "i") : null;
        add("defaults", path, text.split("\n").filter((line) => first.test(line) && (!also || also.test(line))).length);
      } else add("defaults", path, countMatches(text, new RegExp(defaults.pattern, "g")));
    }
    if (schemaFiles.has(path)) {
      const lines = masked.split("\n").filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line));
      add(
        "schema",
        path,
        lines.filter((line) => countMatches(line, patterns.terms) + countMatches(line, patterns.capitalised) > 0).length
      );
    }
    if (termWords.length) samples.set(path, termWords.slice(0, 4));
  }
  return { counts, samples, errors };
}

function laneShards(config, counts) {
  // lane -> metric -> { total, files }
  const out = new Map();
  for (const metric of METRICS) {
    for (const [path, n] of counts[metric]) {
      const lane = laneOf(config, path);
      const shard = out.get(lane) ?? { lane };
      const entry = shard[metric] ?? { total: 0, files: {} };
      entry.files[path] = n;
      entry.total += n;
      shard[metric] = entry;
      out.set(lane, shard);
    }
  }
  for (const shard of out.values()) {
    for (const metric of METRICS) {
      if (!shard[metric]) continue;
      shard[metric].files = Object.fromEntries(
        Object.entries(shard[metric].files).sort(([a], [b]) => (a < b ? -1 : 1))
      );
    }
  }
  return out;
}

const orderShard = (shard) => ({
  lane: shard.lane,
  ...Object.fromEntries(METRICS.filter((m) => shard[m]).map((m) => [m, shard[m]]))
});

function checkTermSets(root, base, config) {
  const errors = [];
  if (!base) return errors;
  const before = showAtBase(root, base, CONFIG);
  if (before === null) return errors;
  const old = JSON.parse(before).terms;
  const flat = (terms) => {
    const sets = new Map();
    sets.set("provider", terms.provider);
    for (const [name, list] of Object.entries(terms.wider)) sets.set(`wider.${name}`, list);
    sets.set("capitalised", terms.capitalised);
    sets.set("owner", terms.owner);
    sets.set("agents.substring", terms.agents.substring);
    sets.set("agents.word", terms.agents.word);
    sets.set("pathWords", terms.pathWords);
    return sets;
  };
  const now = flat(config.terms);
  for (const [name, list] of flat(old)) {
    const kept = new Set(now.get(name) ?? []);
    for (const term of list) {
      if (!kept.has(term))
        errors.push(
          `The term set ${name} in ${CONFIG} lost "${term}". The vendor term sets only grow: restore it. A term is retired by removing the last file that names it, never by narrowing the rule.`
        );
    }
  }
  return errors;
}

// defaults, schema.files and lanes only grow either: a base entry must survive unchanged (the `why` text may change).
function checkGrowOnly(root, base, config) {
  const errors = [];
  if (!base) return errors;
  const before = showAtBase(root, base, CONFIG);
  if (before === null) return errors;
  const old = JSON.parse(before);
  const strip = ({ why: _why, ...rest }) => rest;
  for (const entry of old.defaults ?? []) {
    const now = (config.defaults ?? []).find((candidate) => candidate.id === entry.id);
    if (!now || JSON.stringify(strip(now)) !== JSON.stringify(strip(entry)))
      errors.push(
        `The default "${entry.id}" in ${CONFIG} was removed or changed. The provider-default patterns only grow: restore it and add a new entry for anything new.`
      );
  }
  for (const file of old.schema?.files ?? []) {
    if (!config.schema.files.includes(file))
      errors.push(`schema.files in ${CONFIG} lost ${file}. The schema files only grow: restore it.`);
  }
  for (const entry of old.lanes ?? []) {
    const globs = new Set(config.lanes.filter((lane) => lane.lane === entry.lane).flatMap((lane) => lane.globs));
    for (const glob of entry.globs) {
      if (!globs.has(glob))
        errors.push(`Lane ${entry.lane} in ${CONFIG} lost the pattern ${glob}. Lane patterns only grow: restore it.`);
    }
  }
  return errors;
}

export default function vendorTerms(ctx) {
  const root = ctx.root;
  const args = ctx.args ?? [];
  const errors = [];
  if (!existsSync(resolve(root, CONFIG))) return [`${CONFIG} is missing. It holds the vendor term sets; restore it.`];
  const config = readJson(root, CONFIG);
  const tokens = existsSync(resolve(root, TOKENS)) ? readJson(root, TOKENS) : { entries: [] };
  const tokenRows = tokens.entries;
  const head = hasHead(root);

  if (head) {
    const inHead = (gitOk(root, ["ls-tree", "-r", "--name-only", "HEAD"]) ?? "")
      .split("\n")
      .includes(".sync-core.json");
    const inIndex = trackedFiles(root).includes(".sync-core.json");
    if (inHead || inIndex) {
      errors.push(
        ".sync-core.json is tracked in this repository. It is written only into the composed tree (core plus overlay) by sync-core.mjs, where it lists the files this rule skips. Remove it with `git rm .sync-core.json`; a committed copy would exempt files from the rule."
      );
    }
  }

  const base = resolveBase(root, ctx);
  errors.push(...checkTermSets(root, base, config), ...checkGrowOnly(root, base, config));
  const ci = ctx.env?.CI ?? process.env.CI;
  if (!base && head && ci) {
    errors.push(
      "The commit to compare against could not be found, so the lane-total check cannot run, and CI must not skip it. Fetch more history (for example `fetch-depth: 2` or `git fetch origin main`) or set VENDOR_TERMS_BASE to a commit that exists."
    );
  } else if (!base && head) {
    console.warn(
      "vendor-terms: no base commit found, so the lane-total and term-set comparisons were skipped (fetch origin/main or set VENDOR_TERMS_BASE to run them)."
    );
  }

  const skip = composedSkips(root);
  const result = measure(root, config, tokenRows, { skip });
  errors.push(...result.errors);

  // Platform and interop rows: the path must be tracked and every string must still occur, so the table only shrinks.
  const tracked = new Set(trackedFiles(root));
  for (const row of tokenRows) {
    if (!tracked.has(row.path)) {
      errors.push(`${TOKENS} has a row for ${row.path}, which is not tracked. Delete the row.`);
      continue;
    }
    const text = readFileSync(resolve(root, row.path), "utf8");
    for (const string of row.strings) {
      if (!text.includes(string))
        errors.push(
          `${TOKENS} allows ${JSON.stringify(string)} in ${row.path}, which no longer contains it. Delete that string from the row.`
        );
    }
  }

  const measured = laneShards(config, result.counts);
  let shards = readShards(root);
  const bShards = base ? baseShards(root, base) : null;

  if (args.includes("--fix-pending")) {
    // Rewrite every lane to the measured counts, but never raise a lane total above what it was at the base.
    const cap = (lane, metric) =>
      bShards ? totalOf(bShards, lane, metric) : shards.size ? totalOf(shards, lane, metric) : Infinity;
    const dir = resolve(root, PENDING);
    mkdirSync(dir, { recursive: true });
    const lanes = new Set([...measured.keys(), ...shards.keys()]);
    for (const lane of lanes) {
      const next = { lane };
      const old = shards.get(lane) ?? {};
      for (const metric of METRICS) {
        const now = measured.get(lane)?.[metric];
        if (now && now.total > cap(lane, metric)) {
          errors.push(
            `Refusing to raise ${lane}/${metric} from ${cap(lane, metric)} to ${now.total}: pending counts only shrink. Move the new hits into an add-on (see ${ADDON_DOC}), or move them from a file in the same lane.`
          );
          if (old[metric]) next[metric] = old[metric];
        } else if (now) next[metric] = now;
      }
      const file = join(dir, `${lane}.json`);
      if (METRICS.some((metric) => next[metric])) writeFileSync(file, `${JSON.stringify(orderShard(next), null, 2)}\n`);
      else rmSync(file, { force: true });
    }
    shards = readShards(root);
  }

  // Compare the measured counts with the pending shards.
  for (const [lane, shard] of shards) {
    if (shard.lane !== lane)
      errors.push(`${PENDING}/${lane}.json says lane "${shard.lane}"; the file name and the lane must match.`);
    for (const key of Object.keys(shard)) {
      if (key !== "lane" && !METRICS.includes(key))
        errors.push(`${PENDING}/${lane}.json has an unknown metric "${key}"; use one of ${METRICS.join(", ")}.`);
    }
  }
  const lanes = new Set([...measured.keys(), ...shards.keys()]);
  const describe = {
    terms: "a vendor term",
    agents: "an agent-client term",
    owner: "an owner term",
    paths: "a vendor word in its path",
    schema: "a vendor-named schema line",
    defaults: "a provider-specific default"
  };
  for (const lane of [...lanes].sort()) {
    const shardFile = `${PENDING}/${lane}.json`;
    for (const metric of METRICS) {
      const now = measured.get(lane)?.[metric];
      const declared = shards.get(lane)?.[metric];
      const nowFiles = now?.files ?? {};
      const declaredFiles = declared?.files ?? {};
      if (declared) {
        const sum = Object.values(declaredFiles).reduce((a, b) => a + b, 0);
        if (sum !== declared.total)
          errors.push(`${shardFile} ${metric}: total is ${declared.total} but its files add up to ${sum}. ${FIX}.`);
      }
      for (const path of new Set([...Object.keys(nowFiles), ...Object.keys(declaredFiles)])) {
        const have = nowFiles[path] ?? 0;
        const pending = declaredFiles[path] ?? 0;
        const unit = metric === "paths" ? "path" : "hit";
        const words = result.samples.get(path)?.join(", ");
        if (have > pending && pending === 0) {
          errors.push(
            `${path} is new (or newly) holding ${have} ${metric} ${unit}${have === 1 ? "" : "s"}: ${describe[metric]}${words && metric === "terms" ? ` (${words})` : ""}. Core names no vendor. Move this to an add-on; see ${ADDON_DOC}. If these hits moved here from another file in lane ${lane} and the lane total did not rise, ${FIX}.`
          );
        } else if (have > pending) {
          errors.push(
            `${path} has ${have} ${metric} ${unit}s but ${shardFile} allows ${pending}. Remove the new ones: move them to an add-on (${ADDON_DOC}). Pending counts never go up.`
          );
        } else if (have < pending) {
          errors.push(
            `${path} now has ${have} ${metric} ${unit}s, below the ${pending} in ${shardFile} (the count is stale). Lower ${path} to ${have} in ${shardFile}, or ${FIX}.`
          );
        }
        if (declaredFiles[path] !== undefined && laneOf(config, path) !== lane)
          errors.push(
            `${shardFile} lists ${path}, which belongs to lane ${laneOf(config, path)}. Move the entry, or ${FIX}.`
          );
      }
      if (bShards) {
        const before = totalOf(bShards, lane, metric);
        const after = declared?.total ?? 0;
        if (after > before) {
          errors.push(
            `Lane ${lane} ${metric} total rises from ${before} (at ${base}) to ${after}. A lane total never rises in a pull request. Hits may move to a new file in the same lane only if the total stays level; otherwise move them to an add-on (${ADDON_DOC}).`
          );
        }
      }
    }
  }
  return [...new Set(errors)];
}
