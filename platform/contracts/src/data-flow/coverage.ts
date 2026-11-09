/**
 * Pure rules for reading coverage: the claims a collector made about how far it has read a source (kind `coverage`),
 * merged per source and scope into a high-water mark, plus the per-message end states and the processing gap. No
 * database and no clock of its own. The health reader feeds these rows; the doctor and the attention feed print them.
 * See docs/architecture/activity-store.md, "Coverage", and docs/operations/posting-messages.md.
 */
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Holes (windows nobody claimed) are looked for inside this many days before now, and are reported as a count only. */
export const COVERAGE_HOLE_DAYS = 14;
/** A scope whose high-water mark trails the newest scope's by more than this many days was retired, not behind. */
export const COVERAGE_RETIRED_SCOPE_DAYS = 31;
/**
 * T for a coverage source that sets none: late when it is read up to more than 12 h ago, stale at 2T (24 h). Used only
 * when neither the owner, the collector's declared cadence, the entry nor a learned rhythm gives a number.
 */
export const COVERAGE_DEFAULT_WARN_HOURS = 12;
/** Stale is at 2T, the same ratio the connection rule uses. */
export const COVERAGE_STALE_FACTOR = 2;

/** One claimed window, in epoch milliseconds, start inclusive and end exclusive. */
export interface CoverageWindow {
  start: number;
  end: number;
}

/** What one scope (an account, mailbox or channel; `null` for a source that names none) has claimed. */
export interface ScopeCoverage {
  scope: string | null;
  /** The newest `end` of any window claimed for this scope: its high-water mark. */
  coveredTo: string;
  /** Gaps between claimed windows, inside the last 14 days up to the high-water mark. */
  holes14d: number;
  /** True when this scope stopped being reported more than 31 days before the newest one; it no longer holds the source back. */
  retired?: true;
}

export interface HeartbeatRead {
  at: string;
  status: "ok" | "error";
  /** Untrusted text from the collector, at most 200 characters. */
  error?: string;
}

/** What a source with coverage reported, per scope and overall. Present on a node only for a source that reports any. */
export interface NodeCoverage {
  /** The oldest high-water mark among the scopes still reported: the source is read up to here. Null with no coverage. */
  coveredTo: string | null;
  scopes: ScopeCoverage[];
  holes14d: number;
  /** The newest heartbeat; null when the source sends none. */
  heartbeat: HeartbeatRead | null;
}

/** Merges windows that touch or overlap, ascending. */
export function unionWindows(windows: readonly CoverageWindow[]): CoverageWindow[] {
  const sorted = windows.filter((w) => w.end > w.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const out: CoverageWindow[] = [];
  for (const window of sorted) {
    const last = out[out.length - 1];
    if (last && window.start <= last.end) last.end = Math.max(last.end, window.end);
    else out.push({ ...window });
  }
  return out;
}

/**
 * The gaps between the unioned windows that fall inside `[now - 14 days, high-water]`. The edge before the first
 * window and the time after the high-water mark are not holes (the second is lateness, which freshness reports).
 */
export function countHoles(windows: readonly CoverageWindow[], now: number): number {
  const floor = now - COVERAGE_HOLE_DAYS * DAY_MS;
  const merged = unionWindows(windows).filter((w) => w.end > floor);
  let holes = 0;
  for (let i = 1; i < merged.length; i += 1) if (merged[i]!.start > merged[i - 1]!.end) holes += 1;
  return holes;
}

/**
 * The claims of one scope: high-water mark over everything claimed, holes over what falls in the last 14 days.
 * Returns null when there are no windows.
 */
export function scopeCoverage(
  scope: string | null,
  windows: readonly CoverageWindow[],
  highWater: number | null,
  now: number
): ScopeCoverage | null {
  const newest = Math.max(highWater ?? Number.NEGATIVE_INFINITY, ...windows.map((w) => w.end));
  if (!Number.isFinite(newest)) return null;
  return { scope, coveredTo: new Date(newest).toISOString(), holes14d: countHoles(windows, now) };
}

/**
 * The source's overall high-water mark and the scopes with the retired ones marked. A source reading two mailboxes is
 * read only as far as the slower one, so the overall mark is the oldest of the scopes still reported.
 */
export function mergeScopes(scopes: readonly ScopeCoverage[]): { coveredTo: string | null; scopes: ScopeCoverage[] } {
  if (scopes.length === 0) return { coveredTo: null, scopes: [] };
  const newest = Math.max(...scopes.map((s) => Date.parse(s.coveredTo)));
  const marked = scopes
    .map((s): ScopeCoverage => {
      const retired = newest - Date.parse(s.coveredTo) > COVERAGE_RETIRED_SCOPE_DAYS * DAY_MS;
      return retired ? { ...s, retired: true } : { ...s };
    })
    .sort((a, b) => (a.scope ?? "").localeCompare(b.scope ?? ""));
  const live = marked.filter((s) => s.retired !== true);
  return { coveredTo: new Date(Math.min(...live.map((s) => Date.parse(s.coveredTo)))).toISOString(), scopes: marked };
}

/** Plain words for how a coverage source stands, for a note and a doctor line; the freshness state itself is separate. */
export function coverageNote(
  coverage: NodeCoverage,
  state: "fresh" | "late" | "stale" | "never" | "failing" | "n/a" | "probe_unresolved"
): string | undefined {
  const { coveredTo, heartbeat } = coverage;
  if (state === "failing")
    return heartbeat?.error
      ? `the collector reports an error (${heartbeat.error}); covered up to ${coveredTo ?? "nowhere yet"}`
      : `the collector reports an error; covered up to ${coveredTo ?? "nowhere yet"}`;
  if (coveredTo === null)
    return heartbeat
      ? "the collector is alive (heartbeat) but has not reported reading any window yet"
      : "no window has been reported as read";
  if (state === "late" || state === "stale")
    return heartbeat && heartbeat.status === "ok"
      ? `alive (heartbeat ok at ${heartbeat.at}) but not reading: covered up to ${coveredTo}`
      : `covered up to ${coveredTo}; the collector has sent no healthy heartbeat since`;
  return `covered up to ${coveredTo}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Processing: what became of each message once it was collected.
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The five places a collected message can end up. The same words the replay harness scores (`END_STATES` in planning/replay; a test
 * fails if the two drift), kept here because the data-flow module imports no planning code. `no_effect` always carries a reason in the collector's or reader's own words; there is
 * no preset list of reasons.
 */
export const MESSAGE_END_STATES = ["applied", "duplicate", "asked", "no_effect", "unresolved"] as const;
export type MessageEndState = (typeof MESSAGE_END_STATES)[number];

/** `integration_sync_runs.provider` for a reader or reconciler pass over a source: `reconcile:<source>`. */
export const PROCESSING_RUN_PREFIX = "reconcile:";
export const PROCESSING_MAX_REASONS = 20;
export const PROCESSING_REASON_MAX_CHARS = 100;
export const PROCESSING_MAX_UNRESOLVED_KEYS = 20;

/** The `summary` a pass over a source records in its run row. `messages` is the sum of `endStates`. */
export interface ProcessingRunSummary {
  messages: number;
  endStates: Record<MessageEndState, number>;
  /** Why messages had no effect on the plan: reason to count, in the reader's own words, at most 20 reasons. */
  noEffectReasons?: Record<string, number>;
  /** Event keys of messages that ended `unresolved`, at most 20, so the next call can fetch them. */
  unresolvedKeys?: string[];
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Reads a run's `summary` back. Returns null when it is not a processing summary (a run from something else, or one
 * written by a build that counted differently), so a bad row is counted as unreadable and never as processed.
 */
export function parseProcessingRun(summary: unknown): ProcessingRunSummary | null {
  if (!isRecord(summary) || !isRecord(summary.endStates)) return null;
  const endStates = {} as Record<MessageEndState, number>;
  let total = 0;
  for (const state of MESSAGE_END_STATES) {
    const count = summary.endStates[state] ?? 0;
    if (!isCount(count)) return null;
    endStates[state] = count;
    total += count;
  }
  if (Object.keys(summary.endStates).some((key) => !(MESSAGE_END_STATES as readonly string[]).includes(key)))
    return null;
  if (summary.messages !== undefined && summary.messages !== total) return null;
  let noEffectReasons: Record<string, number> | undefined;
  if (isRecord(summary.noEffectReasons)) {
    const entries = Object.entries(summary.noEffectReasons)
      .filter(([reason, count]) => reason.length > 0 && isCount(count))
      .slice(0, PROCESSING_MAX_REASONS)
      .map(([reason, count]) => [reason.slice(0, PROCESSING_REASON_MAX_CHARS), count as number] as const);
    if (entries.length > 0) noEffectReasons = Object.fromEntries(entries);
  }
  const unresolvedKeys = Array.isArray(summary.unresolvedKeys)
    ? summary.unresolvedKeys
        .filter((key): key is string => typeof key === "string" && key.length > 0 && key.length <= 200)
        .slice(0, PROCESSING_MAX_UNRESOLVED_KEYS)
    : undefined;
  return {
    messages: total,
    endStates,
    ...(noEffectReasons ? { noEffectReasons } : {}),
    ...(unresolvedKeys && unresolvedKeys.length > 0 ? { unresolvedKeys } : {})
  };
}

/** One source's processing report over a window: messages collected against messages that reached an end state. */
export interface ProcessingReport {
  source: string;
  /** The registry's plain name for the source. */
  name: string;
  windowDays: number;
  /** Inbound messages collected in the window (rows of kind message that are not the owner's own). */
  collected: number;
  /** Runs recorded in the window, and how many had a summary that could not be read. */
  runs: number;
  unreadableRuns: number;
  /** Messages that reached a decision (every end state but `unresolved`), counted per decision: a message decided twice counts twice. */
  processed: number;
  /** Collected and not yet decided: `collected - processed`, never below zero. Messages that ended `unresolved` are in it. */
  gap: number;
  byEndState: Record<MessageEndState, number>;
  /** The most common reasons for `no_effect`, most common first, at most 5. */
  noEffectReasons: { reason: string; count: number }[];
  unresolvedKeys: string[];
  lastRunAt: string | null;
}

export function summarizeProcessing(input: {
  source: string;
  name: string;
  windowDays: number;
  collected: number;
  runs: readonly { at: string; summary: unknown }[];
}): ProcessingReport {
  const byEndState = Object.fromEntries(MESSAGE_END_STATES.map((state) => [state, 0])) as Record<
    MessageEndState,
    number
  >;
  const reasons = new Map<string, number>();
  const unresolvedKeys: string[] = [];
  let unreadable = 0;
  let lastRunAt: string | null = null;
  for (const run of input.runs) {
    const parsed = parseProcessingRun(run.summary);
    if (!parsed) {
      unreadable += 1;
      continue;
    }
    if (lastRunAt === null || run.at > lastRunAt) lastRunAt = run.at;
    for (const state of MESSAGE_END_STATES) byEndState[state] += parsed.endStates[state];
    for (const [reason, count] of Object.entries(parsed.noEffectReasons ?? {}))
      reasons.set(reason, (reasons.get(reason) ?? 0) + count);
    for (const key of parsed.unresolvedKeys ?? [])
      if (unresolvedKeys.length < PROCESSING_MAX_UNRESOLVED_KEYS && !unresolvedKeys.includes(key))
        unresolvedKeys.push(key);
  }
  // `unresolved` means the pass could not decide, so it is not a decision and stays in the gap.
  const processed = MESSAGE_END_STATES.reduce(
    (sum, state) => (state === "unresolved" ? sum : sum + byEndState[state]),
    0
  );
  return {
    source: input.source,
    name: input.name,
    windowDays: input.windowDays,
    collected: input.collected,
    runs: input.runs.length,
    unreadableRuns: unreadable,
    processed,
    gap: Math.max(0, input.collected - processed),
    byEndState,
    noEffectReasons: [...reasons.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([reason, count]) => ({ reason, count })),
    unresolvedKeys,
    lastRunAt
  };
}

/**
 * One plain line: "mail: 234 messages collected in 30 days, 70 decided (applied 3, ...), 12 unresolved, 164 not yet decided
 * (approximate: ...)". Null when nothing was collected. The gap is approximate because collected counts every inbound message
 * while a pass only records the ones it looked at, until the reconciler records `no_effect` for the rest.
 */
export function processingLine(report: ProcessingReport): string | null {
  if (report.collected === 0 && report.processed === 0 && report.byEndState.unresolved === 0) return null;
  const parts = MESSAGE_END_STATES.filter((state) => state !== "unresolved" && report.byEndState[state] > 0).map(
    (state) => `${state.replace("_", " ")} ${report.byEndState[state]}`
  );
  const decided =
    report.runs === 0
      ? "no processing run is recorded"
      : `${report.processed} decided${parts.length > 0 ? ` (${parts.join(", ")})` : ""}${report.byEndState.unresolved > 0 ? `, ${report.byEndState.unresolved} unresolved` : ""}`;
  return `${report.name}: ${report.collected} messages collected in ${report.windowDays} days, ${decided}, ${report.gap} not yet decided (approximate until the reconciler records no_effect for the messages it skips).`;
}
