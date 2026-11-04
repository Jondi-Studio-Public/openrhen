import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
 *  - The journal itself (`journalProblems`): `idx` runs 0, 1, 2… with each tag's number equal to its idx,
 *    `when` strictly increases, every tag has its .sql file, and the snapshots (all but the early ones that
 *    never had one) form one `prevId` chain, so no two branches generated from the same parent.
 *  - Against the base (`journalChangeProblems`): every entry main already has keeps its idx, tag and `when`,
 *    in the same place, and every new entry is stamped later than all of them. In CI the checkout is the
 *    merge commit, so HEAD^1 is main as it is now, not where the branch started.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const MIGRATIONS_DIR = "platform/database/drizzle";
export const JOURNAL_PATH = `${MIGRATIONS_DIR}/meta/_journal.json`;

/** Migrations from before snapshots were kept for every one (0008-0017, 0050-0055); the chain skips them. */
export const NO_SNAPSHOT = new Set([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 50, 51, 52, 53, 54, 55]);

const pad = (idx) => String(idx).padStart(4, "0");

/**
 * Problems with one journal. `files.sql(tag)` says whether a migration's .sql file exists, and
 * `files.snapshot(idx)` returns its parsed snapshot (`{ id, prevId }`) or undefined.
 */
export function journalProblems(entries, files) {
  const problems = [];
  let previousWhen = -Infinity;
  let previousSnapshot;
  entries.forEach((entry, position) => {
    const { idx, tag, when } = entry;
    if (idx !== position)
      problems.push(`entry ${position} (${tag}) has idx ${idx}; idx must run 0, 1, 2… with no gaps`);
    if (!String(tag).startsWith(`${pad(idx)}_`))
      problems.push(`${tag} is idx ${idx}, so its tag must start ${pad(idx)}_`);
    if (!Number.isFinite(when) || when <= previousWhen)
      problems.push(
        `${tag} has when ${when}, not later than the entry before it (${previousWhen}); drizzle would skip it on a database that already has that one`
      );
    if (Number.isFinite(when)) previousWhen = when;
    if (!files.sql(tag)) problems.push(`${tag} has no ${MIGRATIONS_DIR}/${tag}.sql`);
    if (NO_SNAPSHOT.has(idx)) return;
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

/** The journal at HEAD^1 (main, in CI's merge commit), or undefined when there is no parent or it had no journal. */
function baseJournal() {
  try {
    return readJournal(
      execFileSync("git", ["show", `HEAD^1:${JOURNAL_PATH}`], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      })
    );
  } catch {
    return undefined;
  }
}

export function checkWorkingTree(dir = root) {
  const entries = readJournal(readFileSync(join(dir, JOURNAL_PATH), "utf8"));
  return journalProblems(entries, {
    sql: (tag) => existsSync(join(dir, MIGRATIONS_DIR, `${tag}.sql`)),
    snapshot: (idx) => {
      const path = join(dir, MIGRATIONS_DIR, "meta", `${pad(idx)}_snapshot.json`);
      return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
    }
  });
}

function main() {
  const head = readJournal(readFileSync(join(root, JOURNAL_PATH), "utf8"));
  const problems = checkWorkingTree();
  const base = baseJournal();
  if (base) problems.push(...journalChangeProblems(base, head));
  else console.log("No parent commit to compare the migration journal with; checked its shape only.");
  if (problems.length === 0) {
    console.log(
      `Migration journal OK: ${head.length} entries${base ? `, ${head.length - base.length} new since HEAD^1` : ""}.`
    );
    return;
  }
  const summary = ["### Migration journal", "", ...problems.map((problem) => `- ${problem}`)].join("\n");
  for (const problem of problems) console.log(`::error file=${JOURNAL_PATH}::${problem}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n\n`);
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
