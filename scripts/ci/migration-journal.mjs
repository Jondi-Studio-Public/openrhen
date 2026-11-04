import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Fails a pull request whose migration journal would make drizzle skip a migration on a database that is
 * already up to date with main.
 *
 * Drizzle's migrator applies a journal entry only when its `when` is newer than the newest `created_at` in
 * `drizzle.__drizzle_migrations` (drizzle-orm pg-core dialect), and `pending-migrations.ts` reports pending
 * work by the same rule. So an entry stamped older than one main has already deployed is never applied, and
 * the deploy logs "Nothing to migrate". An empty CI database applies every file whatever its `when`, so no
 * test would notice. `drizzle-kit generate` stamps `when` at generation time, so two PRs generating in
 * parallel and merging in the other order, or a hand-resolved journal conflict, is enough to cause it.
 *
 * Two checks:
 *
 *  - The journal itself (`journalProblems`): `idx` runs contiguously from the baseline's `baselineIdx` (0 when
 *    the folder has no `meta/baseline.json`) with each tag's number equal to its idx,
 *    `when` strictly increases, every tag has its .sql file, and the snapshots (all but the early ones that
 *    never had one) form one `prevId` chain, so no two branches generated from the same parent.
 *  - `meta/baseline.json` (`baselineProblems`), when present: the legacy history it replaces runs 0..baselineIdx
 *    with strictly increasing `when`s, and for the core set the baseline entry's `when` is the last legacy `when`;
 *    `laterLegacy` continues after the baseline with no gaps; every journal entry up to the last `laterLegacy`
 *    idx is listed there with the same `when`; and a new core entry is stamped later than every legacy and
 *    `laterLegacy` `when`. An add-on baseline (`legacyLedger: "core"`) shares core's ledger, so it has no
 *    last-legacy-when rule and no S6 rule.
 *  - Against the base (`journalChangeProblems`): every entry main already has keeps its idx, tag and `when`,
 *    in the same place, and every new entry is stamped later than all of them. In CI the checkout is the
 *    merge commit, so HEAD^1 is main as it is now, not where the branch started.
 */
/** Run per migration set: `--dir <folder>` (default `platform/database/drizzle`; the add-on set is `platform/database/addon-drizzle` in a composed tree). */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const MIGRATIONS_DIR = "platform/database/drizzle";
export const JOURNAL_PATH = `${MIGRATIONS_DIR}/meta/_journal.json`;

/** Migrations from before snapshots were kept for every one (0008-0017, 0050-0055); the chain skips them. Legacy idx only. */
export const NO_SNAPSHOT = new Set([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 50, 51, 52, 53, 54, 55]);

const pad = (idx) => String(idx).padStart(4, "0");

/**
 * Problems with one journal. `files.sql(tag)` says whether a migration's .sql file exists, and
 * `files.snapshot(idx)` returns its parsed snapshot (`{ id, prevId }`) or undefined. `options.start` is the
 * first idx (the baseline's `baselineIdx`, else 0), `options.dir` names the folder in messages and
 * `options.noSnapshot` is the set of idx exempt from the snapshot chain (default `NO_SNAPSHOT`).
 */
export function journalProblems(entries, files, options = {}) {
  const { start = 0, dir = MIGRATIONS_DIR, noSnapshot = NO_SNAPSHOT } = options;
  const problems = [];
  let previousWhen = -Infinity;
  let previousSnapshot;
  entries.forEach((entry, position) => {
    const { idx, tag, when } = entry;
    if (idx !== start + position)
      problems.push(
        `entry ${position} (${tag}) has idx ${idx}; idx must run ${start}, ${start + 1}, ${start + 2}… with no gaps`
      );
    if (!String(tag).startsWith(`${pad(idx)}_`))
      problems.push(`${tag} is idx ${idx}, so its tag must start ${pad(idx)}_`);
    if (!Number.isFinite(when) || when <= previousWhen)
      problems.push(
        `${tag} has when ${when}, not later than the entry before it (${previousWhen}); drizzle would skip it on a database that already has that one`
      );
    if (Number.isFinite(when)) previousWhen = when;
    if (!files.sql(tag)) problems.push(`${tag} has no ${dir}/${tag}.sql`);
    if (noSnapshot.has(idx)) return;
    const snapshot = files.snapshot(idx);
    if (!snapshot) {
      problems.push(`${tag} has no meta/${pad(idx)}_snapshot.json`);
      return;
    }
    if (previousSnapshot && snapshot.prevId !== previousSnapshot.id)
      problems.push(
        `meta/${pad(idx)}_snapshot.json has prevId ${snapshot.prevId}, but the snapshot before it is ${previousSnapshot.id}; regenerate it from main's latest snapshot`
      );
    previousSnapshot = snapshot;
  });
  return problems;
}

/**
 * Problems with a set's `meta/baseline.json` against its journal entries. A baseline with
 * `legacyLedger: "core"` (the add-on's) shares core's ledger: it skips the last-legacy-when and new-entry rules.
 */
export function baselineProblems(baseline, entries) {
  const problems = [];
  const { baselineIdx } = baseline;
  const legacy = Array.isArray(baseline.legacy) ? baseline.legacy : [];
  const later = Array.isArray(baseline.laterLegacy) ? baseline.laterLegacy : [];
  const ownLedger = baseline.legacyLedger !== "core";
  if (!Number.isInteger(baselineIdx) || baselineIdx < 0) {
    problems.push(`baseline.json baselineIdx ${baselineIdx} is not a non-negative integer`);
    return problems;
  }
  if (entries.length === 0 || entries[0].idx !== baselineIdx)
    problems.push(
      `baseline.json says baselineIdx ${baselineIdx}, but the journal starts at idx ${entries[0]?.idx}; the baseline entry must be first`
    );

  if (legacy.length > 0) {
    // A set sharing core's ledger lists core's whole legacy history, not its own idx run.
    legacy.forEach((row, position) => {
      if (ownLedger && row.idx !== position)
        problems.push(
          `baseline.json legacy entry ${position} has idx ${row.idx}; legacy idx must run 0..${baselineIdx} with no gaps`
        );
    });
    if (ownLedger && legacy.length !== baselineIdx + 1)
      problems.push(
        `baseline.json legacy has ${legacy.length} entries; it must run 0..${baselineIdx} (${baselineIdx + 1})`
      );
    legacy.forEach((row, position) => {
      if (position > 0 && !(row.when > legacy[position - 1].when))
        problems.push(
          `baseline.json legacy idx ${row.idx} has when ${row.when}, not later than idx ${legacy[position - 1].idx} (${legacy[position - 1].when})`
        );
    });
    const lastLegacy = legacy[legacy.length - 1];
    const baselineEntry = entries.find((entry) => entry.idx === baselineIdx);
    if (ownLedger && baselineEntry && lastLegacy.when !== baselineEntry.when)
      problems.push(
        `baseline entry ${baselineEntry.tag} has when ${baselineEntry.when}, but the last legacy when is ${lastLegacy.when}; they must be equal`
      );
  }

  later.forEach((row, position) => {
    if (row.idx !== baselineIdx + 1 + position)
      problems.push(
        `baseline.json laterLegacy entry ${position} has idx ${row.idx}; it must continue after ${baselineIdx} as ${baselineIdx + 1 + position}`
      );
  });
  const lastLaterIdx = later.length > 0 ? Math.max(...later.map((row) => row.idx)) : baselineIdx;
  const laterByIdx = new Map(later.map((row) => [row.idx, row]));
  for (const entry of entries) {
    if (entry.idx <= baselineIdx || entry.idx > lastLaterIdx) continue;
    const row = laterByIdx.get(entry.idx);
    if (!row)
      problems.push(
        `${entry.tag} is in the journal but not in baseline.json laterLegacy; list it there with the same when`
      );
    else if (row.when !== entry.when)
      problems.push(
        `${entry.tag} has when ${entry.when} but baseline.json laterLegacy has ${row.when}; they must be equal`
      );
  }
  for (const row of later)
    if (row.exported && !entries.some((entry) => entry.idx === row.idx))
      problems.push(`baseline.json laterLegacy idx ${row.idx} is marked exported but the journal has no such entry`);

  if (ownLedger) {
    const newest = Math.max(-Infinity, ...legacy.map((row) => row.when), ...later.map((row) => row.when));
    for (const entry of entries)
      if (entry.idx > lastLaterIdx && !(entry.when > newest))
        problems.push(
          `${entry.tag} has when ${entry.when}, not later than the newest legacy migration (${newest}) in baseline.json; a database that ran the legacy history would skip it. Set its when to the current time in ms (Date.now())`
        );
  }
  return problems;
}

/** Problems with `head`'s journal compared with `base`'s: base must be an unchanged prefix, new entries later than all of it. */
export function journalChangeProblems(base, head) {
  const problems = [];
  base.forEach((entry, position) => {
    const now = head[position];
    if (!now) problems.push(`${entry.tag} is on main but missing here; never remove a deployed migration`);
    else if (now.tag !== entry.tag || now.idx !== entry.idx || now.when !== entry.when)
      problems.push(
        `entry ${position} is ${entry.tag} (when ${entry.when}) on main but ${now.tag} (when ${now.when}) here; a migration main has deployed must keep its place, tag and when, so add new ones after it`
      );
  });
  const baseLatest = Math.max(-Infinity, ...base.map((entry) => entry.when));
  for (const entry of head.slice(base.length))
    if (!(entry.when > baseLatest))
      problems.push(
        `${entry.tag} has when ${entry.when}, not later than main's newest (${baseLatest}); a deployed database would skip it. Set its when to the current time in ms (Date.now()), after main's`
      );
  return problems;
}

function readJournal(text) {
  return JSON.parse(text).entries;
}

/** The journal at HEAD^1 (main, in CI's merge commit) for the set in `dir`, or undefined when there is no parent or it had no journal. */
function baseJournal(dir) {
  try {
    const git = (args) =>
      execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const prefix = git(["rev-parse", "--show-prefix"]).trim();
    return readJournal(git(["show", `HEAD^1:${prefix}meta/_journal.json`]));
  } catch {
    return undefined;
  }
}

/** The `meta/baseline.json` at HEAD^1 for the set in `dir`, or undefined when there is none. */
function baseBaseline(dir) {
  try {
    const git = (args) =>
      execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const prefix = git(["rev-parse", "--show-prefix"]).trim();
    return JSON.parse(git(["show", `HEAD^1:${prefix}meta/baseline.json`]));
  } catch {
    return undefined;
  }
}

/**
 * Problems with `head`'s baseline.json against `base`'s: what main already has (baselineIdx, the legacy list and
 * the laterLegacy rows) must not change, so a PR cannot widen the snapshot and newer-than-legacy exemptions to
 * wave its own new migration through. New laterLegacy rows may be appended: that is what a sync of exported
 * legacy migrations does, and a reviewer sees it in the diff.
 */
export function baselineChangeProblems(base, head) {
  if (!base) return [];
  if (!head) return ["baseline.json is on main but missing here; never remove it"];
  const problems = [];
  if (base.baselineIdx !== head.baselineIdx) problems.push("baseline.json baselineIdx differs from main's");
  if (JSON.stringify(base.legacy) !== JSON.stringify(head.legacy))
    problems.push("baseline.json legacy differs from main's; the replaced history never changes");
  const baseLater = base.laterLegacy ?? [];
  const headLater = head.laterLegacy ?? [];
  if (JSON.stringify(baseLater) !== JSON.stringify(headLater.slice(0, baseLater.length)))
    problems.push("baseline.json laterLegacy rows main already has were changed or removed");
  return problems;
}

/** Reads the set in `dir`; undefined when it has no `meta/_journal.json`. */
export function readMigrationSet(dir) {
  const journalPath = join(dir, "meta/_journal.json");
  if (!existsSync(journalPath)) return undefined;
  const baselinePath = join(dir, "meta/baseline.json");
  return {
    entries: readJournal(readFileSync(journalPath, "utf8")),
    baseline: existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : undefined
  };
}

export function checkMigrationsDir(dir, set = readMigrationSet(dir)) {
  const label = relative(root, dir) || dir;
  const problems = journalProblems(
    set.entries,
    {
      sql: (tag) => existsSync(join(dir, `${tag}.sql`)),
      snapshot: (idx) => {
        const path = join(dir, "meta", `${pad(idx)}_snapshot.json`);
        return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
      }
    },
    {
      start: set.baseline?.baselineIdx ?? 0,
      dir: label,
      // Legacy migrations exported after the baseline (laterLegacy) carry no snapshot of their own.
      noSnapshot: new Set([...NO_SNAPSHOT, ...(set.baseline?.laterLegacy ?? []).map((row) => row.idx)])
    }
  );
  if (set.baseline) problems.push(...baselineProblems(set.baseline, set.entries));
  const tags = new Set(set.entries.map((entry) => entry.tag));
  for (const file of existsSync(dir) ? readdirSync(dir) : [])
    if (file.endsWith(".sql") && !tags.has(file.slice(0, -4)))
      problems.push(`${label}/${file} has no journal entry; drizzle would never run it`);
  return problems;
}

/**
 * The refusal when a folder has no journal: core's must exist, and so must any folder main already had one for.
 * Only an add-on folder that has never had a journal is skipped.
 */
export function missingJournalProblem(label, isCore, baseHadJournal) {
  if (isCore) return `${label}/meta/_journal.json is missing; core's migration journal must exist`;
  if (baseHadJournal) return `${label}/meta/_journal.json is on main but missing here; never remove a deployed journal`;
  return undefined;
}

export function parseDir(argv) {
  const at = argv.indexOf("--dir");
  if (at === -1) return resolve(root, MIGRATIONS_DIR);
  if (!argv[at + 1]) throw new Error("--dir needs a migrations folder");
  return resolve(argv[at + 1]);
}

function main() {
  const dir = parseDir(process.argv.slice(2));
  const label = relative(root, dir) || dir;
  const set = readMigrationSet(dir);
  if (!set) {
    const problem = missingJournalProblem(label, dir === resolve(root, MIGRATIONS_DIR), baseJournal(dir) !== undefined);
    if (!problem) {
      console.log(`No ${label}/meta/_journal.json; nothing to check for this migration set.`);
      return;
    }
    console.log(`::error file=${label}/meta/_journal.json::${problem}`);
    process.exitCode = 1;
    return;
  }
  const problems = checkMigrationsDir(dir, set);
  const base = baseJournal(dir);
  if (base) problems.push(...journalChangeProblems(base, set.entries));
  if (base) problems.push(...baselineChangeProblems(baseBaseline(dir), set.baseline));
  else console.log("No parent commit to compare the migration journal with; checked its shape only.");
  if (problems.length === 0) {
    console.log(
      `Migration journal OK (${label}): ${set.entries.length} entries${base ? `, ${set.entries.length - base.length} new since HEAD^1` : ""}.`
    );
    return;
  }
  const summary = [`### Migration journal (${label})`, "", ...problems.map((problem) => `- ${problem}`)].join("\n");
  for (const problem of problems) console.log(`::error file=${label}/meta/_journal.json::${problem}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n\n`);
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
