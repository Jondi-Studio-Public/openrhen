import { normalizeTitle, titleSimilarity, titlesMatch } from "./title-similarity.js";

/**
 * Deadline and ask matching: decides whether a deadline or an open ask arriving in a message is one the
 * plan already holds, including a deadline that has moved. Pure: the caller loads the target rows
 * (open actions, deliverables, projects with an external deadline, open ask facts) and acts on the
 * answer. Ties follow `matchCommitment`: several equal best matches return `tie: true` and
 * `candidates`, never a pick.
 */

export interface DeadlineProbe {
  kind: "deadline" | "ask";
  title: string;
  /** YYYY-MM-DD in the user's timezone; null for a plain ask with no date. */
  dueOn: string | null;
  /** Unit codes found in the title (`extractUnitCodes`); the caller owns the code pattern. */
  unitCodes?: readonly string[];
  /** The caller found `RESCHEDULE_CUE` in the message: it says this is a move, not a new instance. */
  rescheduled?: boolean;
}

export interface DeadlineTarget {
  id: string;
  title: string;
  /** YYYY-MM-DD, or null for an ask or an undated target. */
  dueOn: string | null;
  /** Closed targets (done, cancelled, answered) are never candidates. Defaults to open. */
  open?: boolean;
  unitCodes?: readonly string[];
}

export type DeadlineMatchKind = "exact" | "strong" | "possible" | "none";

export interface DeadlineMatch {
  kind: DeadlineMatchKind;
  /** The one target matched; on a tie, the earliest tied one (a stand-in, never a pick). */
  targetId?: string;
  reason: string;
  /**
   * Set when the title or code matches but the dates differ. With strong or exact it is the same deadline
   * moved (an update, not a duplicate); with possible (more than two weeks apart) it is only a hint that the
   * date differs, so a caller must not treat it as a restatement.
   */
  moved?: { from: string; to: string };
  /** Several targets matched equally at `kind`; same rules as `SourceMatch.tie`. */
  tie?: true;
  /** The tied targets, earliest due date first (undated last, then id), at most `MAX_DEADLINE_TIE_CANDIDATES`. */
  candidates?: string[];
}

export const MAX_DEADLINE_TIE_CANDIDATES = 5;
/** Words in a message that say a date moved; callers set `DeadlineProbe.rescheduled` from this. */
export const RESCHEDULE_CUE = /\b(moved|rescheduled|postponed|delayed|extended|pushed back|brought forward)\b/i;
/** A deadline the same title names within this many days is the same one, moved. */
export const MOVED_WINDOW_DAYS = 14;
/** Same date and at least this title similarity is a possible match when the titles do not match outright. */
export const SAME_DATE_SIMILARITY = 0.3;

const RANK: Record<DeadlineMatchKind, number> = { none: 0, possible: 1, strong: 2, exact: 3 };
const DAY_MS = 86_400_000;
const NONE: DeadlineMatch = { kind: "none", reason: "No match" };

function daysBetween(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS;
}

function numbersIn(title: string): Set<string> {
  return new Set(normalizeTitle(title).match(/\p{N}+/gu) ?? []);
}

/**
 * "Assignment 1" and "Assignment 2" contain each other's words but are different things. Numbers are whole
 * tokens, and the titles differ only when neither number set is within the other: "Quiz 3 due 15" still
 * matches "Quiz 3" (the extra number is a date), "Assignment 1" does not match "Assignment 12".
 */
function numbersDiffer(a: string, b: string): boolean {
  const left = numbersIn(a);
  const right = numbersIn(b);
  const within = (small: Set<string>, large: Set<string>) => [...small].every((n) => large.has(n));
  return !within(left, right) && !within(right, left);
}

function matchOne(probe: DeadlineProbe, target: DeadlineTarget): DeadlineMatch {
  const moved =
    probe.dueOn !== null && target.dueOn !== null && probe.dueOn !== target.dueOn
      ? { from: target.dueOn, to: probe.dueOn }
      : undefined;
  const sharesCode = (probe.unitCodes ?? []).some((code) => (target.unitCodes ?? []).includes(code));
  if (sharesCode) {
    return { kind: "exact", reason: "Names the same unit code", ...(moved ? { moved } : {}) };
  }
  if (numbersDiffer(probe.title, target.title)) return NONE;
  const titles = titlesMatch(probe.title, target.title);
  if (probe.dueOn === null || target.dueOn === null) {
    return titles ? { kind: "possible", reason: "Matching title, no date to compare" } : NONE;
  }
  const apart = daysBetween(probe.dueOn, target.dueOn);
  if (titles && apart === 0) return { kind: "strong", reason: "Same title on the same date" };
  // The same unnumbered title a whole number of weeks away is what a weekly series looks like: a new instance
  // as much as a move. Without a reschedule cue it is a question, not an update.
  const weekly = apart % 7 === 0 && numbersIn(probe.title).size === 0 && numbersIn(target.title).size === 0;
  if (titles && apart <= MOVED_WINDOW_DAYS && weekly && !probe.rescheduled) {
    return { kind: "possible", reason: "Same title a whole number of weeks apart, no sign of a move", moved: moved! };
  }
  if (titles && apart <= MOVED_WINDOW_DAYS) {
    return { kind: "strong", reason: `Same title, date moved by ${apart} days`, moved: moved! };
  }
  if (titles) {
    return { kind: "possible", reason: "Matching title on a date more than two weeks apart", moved: moved! };
  }
  if (apart === 0 && titleSimilarity(probe.title, target.title) >= SAME_DATE_SIMILARITY) {
    return { kind: "possible", reason: "Same date and a similar title" };
  }
  return NONE;
}

function dueOrder(a: DeadlineTarget, b: DeadlineTarget): number {
  if (a.dueOn !== b.dueOn) {
    if (a.dueOn === null) return 1;
    if (b.dueOn === null) return -1;
    return a.dueOn < b.dueOn ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The best match for `probe` among the open `targets` (exact over strong over possible). A unit code
 * that exactly one target names is exact; a code several name decides nothing by itself. Two or
 * more targets at the best rank are a tie, the same whatever the order of `targets`.
 */
export function matchDeadline(probe: DeadlineProbe, targets: readonly DeadlineTarget[]): DeadlineMatch {
  const open = targets.filter((target) => target.open !== false);
  const codeHolders = (code: string) => open.filter((t) => (t.unitCodes ?? []).includes(code)).length;
  // A code several targets share names none of them; those fall back to the title rules.
  const unique = (probe.unitCodes ?? []).filter((code) => codeHolders(code) === 1);
  const asProbe: DeadlineProbe = { ...probe, unitCodes: unique };

  let best: DeadlineMatch = NONE;
  let atBest: { target: DeadlineTarget; match: DeadlineMatch }[] = [];
  for (const target of open) {
    const match = matchOne(asProbe, target);
    if (RANK[match.kind] > RANK[best.kind]) {
      best = match;
      atBest = [{ target, match }];
    } else if (match.kind !== "none" && RANK[match.kind] === RANK[best.kind]) {
      atBest.push({ target, match });
    }
  }
  if (atBest.length === 0) return NONE;
  if (atBest.length === 1) return { ...atBest[0]!.match, targetId: atBest[0]!.target.id };
  const ordered = atBest.map((entry) => entry.target).sort(dueOrder);
  return {
    kind: best.kind,
    targetId: ordered[0]!.id,
    reason: `${ordered.length} targets fit equally`,
    tie: true,
    candidates: ordered.slice(0, MAX_DEADLINE_TIE_CANDIDATES).map((target) => target.id)
  };
}
