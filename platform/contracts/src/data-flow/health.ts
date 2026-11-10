import { COVERAGE_STALE_FACTOR, type NodeCoverage } from "./coverage.js";
import { RHYTHM_DECLARED_CAP_FACTOR, formatSpan, type Rhythm } from "./rhythm.js";
import type { FlowEntry } from "./types.js";

/** Pure freshness rules for the health reader (design 4.3): no database, no clock of its own. */

const HOUR_MS = 3_600_000;
const MIN_HOURS = 2;
const MAX_HOURS = 14 * 24;
const MIN_BUCKETS = 20;

export type FreshnessState = "fresh" | "late" | "stale" | "never" | "failing" | "n/a" | "probe_unresolved";

export interface ThresholdInUse {
  warnHours: number;
  /** Null when the source states only a warning (phone pings). */
  errorHours: number | null;
  /**
   * `owner` (the owner's own expectation, a source that reports coverage), `collector` (the cadence the collector
   * declares), `learned` (a coverage source's own rhythm, past its minimums; or, for a device, arrivals over 30 days),
   * `provisional` (a coverage source's rhythm from 2 to 5 gaps or too short a history: degrading only, never blocking),
   * `connection`, `overlay` (an extension's own number) or `default`. A coverage source with fewer than 2 gaps and
   * nothing declared has no threshold at all (`NodeHealth.noRhythm`): no hour number applies to anyone.
   */
  from: "owner" | "collector" | "learned" | "provisional" | "connection" | "overlay" | "default";
  /** Days of arrivals a learned device threshold rests on. The doctor limits a short history to the degrading tier. */
  days?: number;
  /** Learned, provisional or owner: the source's usual gap (its median, or the owner's N) in minutes. */
  usualMinutes?: number;
  /** Learned or provisional: the gaps the limit rests on. */
  gaps?: number;
  /** Owner: the N the owner expects, so T = 3N. */
  expectedEveryMinutes?: number;
  /** Provisional: what is still missing before the limit may block. */
  provisional?: { moreUpdates: number; moreHours: number };
  /** The source just resumed after a gap longer than twice its limit, in hours: blocking waits until 1.5 x that. */
  rhythmChanged?: { lastGapHours: number };
  /** Collector: the limit the source's own posts would give (late after this many hours) when it is more than 3 x the declared one. */
  observedWarnHours?: number;
  /** Learned: the declared limit (late after this many hours) when it differs from the learned one by more than 3 x. */
  declaredWarnHours?: number;
}

const MIN_MS = 60_000;
const clamp = (hours: number) => Math.min(MAX_HOURS, Math.max(MIN_HOURS, hours));

/** Warn at 1.5 x and error at 3 x the p95 gap between hourly buckets of arrivals; needs 20 buckets. */
export function learnThreshold(
  arrivalsMs: readonly number[]
): { warnHours: number; errorHours: number; days: number } | null {
  const buckets = [...new Set(arrivalsMs.map((ms) => Math.floor(ms / HOUR_MS)))].sort((a, b) => a - b);
  if (buckets.length < MIN_BUCKETS) return null;
  const gaps = buckets.slice(1).map((bucket, index) => bucket - buckets[index]!);
  gaps.sort((a, b) => a - b);
  const p95 = gaps[Math.min(gaps.length - 1, Math.ceil(gaps.length * 0.95) - 1)]!;
  const days = Math.floor((buckets[buckets.length - 1]! - buckets[0]!) / 24);
  return { warnHours: clamp(1.5 * p95), errorHours: clamp(3 * p95), days };
}

/** What a source that reports coverage brings to its threshold. Present only for such a source. */
export interface CoverageThresholdContext {
  /** The owner's `expectedEveryMinutes` for the source (N: T is 3N); absent or null means none is set. */
  ownerExpectedEveryMinutes?: number | null;
  /** The cadence the collector declared in its registry entry's availability. */
  collector?: { expectedEveryMinutes?: number; silentAfterMinutes?: number } | null;
  /** What the source's own coverage posts say (`learnRhythm`). */
  rhythm?: Rhythm | null;
}

export interface ThresholdContext {
  /** `doctorSyncCadence()` as provider to late-after milliseconds. */
  cadenceLateAfterMs?: Readonly<Record<string, number>>;
  learned?: { warnHours: number; errorHours: number; days: number } | null;
  coverage?: CoverageThresholdContext;
}

/** T for a source that states how far behind it may be: late at T, stale at 2T. */
const behind = (minutes: number, from: ThresholdInUse["from"]): ThresholdInUse => ({
  warnHours: minutes / 60,
  errorHours: (COVERAGE_STALE_FACTOR * minutes) / 60,
  from
});

/** The collector's declared T in minutes: `silentAfterMinutes`, else 3 x `expectedEveryMinutes`; null when none. */
function declaredMinutes(declared: CoverageThresholdContext["collector"]): number | null {
  if (declared?.silentAfterMinutes !== undefined && declared.silentAfterMinutes > 0) return declared.silentAfterMinutes;
  if (declared?.expectedEveryMinutes !== undefined && declared.expectedEveryMinutes > 0)
    return 3 * declared.expectedEveryMinutes;
  return null;
}

const differsBy = (a: number, b: number, factor: number) => a > factor * b || b > factor * a;

/**
 * A limit a coverage source may be judged and blocked on, or null: the owner's expectation (T = 3N), then the source's own
 * rhythm once real (6 gaps and a history of max(24 h, 4T)), held to 4 x the declared limit when the collector declares one,
 * then the declared cadence. A declared cadence is real from day one; a learned one that is still provisional does not outrank it.
 */
function realCoverageThreshold(coverage: CoverageThresholdContext): ThresholdInUse | null {
  const owner = coverage.ownerExpectedEveryMinutes;
  if (typeof owner === "number" && owner > 0)
    return { ...behind(3 * owner, "owner"), usualMinutes: owner, expectedEveryMinutes: owner };
  const declared = declaredMinutes(coverage.collector);
  const rhythm = coverage.rhythm;
  if (rhythm?.real && rhythm.limitMs !== null) {
    const learnedMinutes = rhythm.limitMs / MIN_MS;
    if (declared !== null && learnedMinutes > RHYTHM_DECLARED_CAP_FACTOR * declared)
      return {
        ...behind(RHYTHM_DECLARED_CAP_FACTOR * declared, "collector"),
        observedWarnHours: learnedMinutes / 60
      };
    return {
      ...behind(learnedMinutes, "learned"),
      usualMinutes: rhythm.usualMs! / MIN_MS,
      gaps: rhythm.gaps,
      ...(rhythm.changed ? { rhythmChanged: { lastGapHours: rhythm.lastGapMs! / 3_600_000 } } : {}),
      ...(declared !== null && differsBy(learnedMinutes, declared, 3) ? { declaredWarnHours: declared / 60 } : {})
    };
  }
  if (declared !== null) {
    const observed = rhythm?.limitMs ? rhythm.limitMs / MIN_MS : null;
    return {
      ...behind(declared, "collector"),
      ...(observed !== null && differsBy(observed, declared, 3) ? { observedWarnHours: observed / 60 } : {})
    };
  }
  return null;
}

/** A limit from 2 to 5 gaps, or from a history that is still too short: late and stale show, but it never blocks. */
function provisionalCoverageThreshold(rhythm: Rhythm | null | undefined): ThresholdInUse | null {
  if (!rhythm || rhythm.limitMs === null) return null;
  return {
    ...behind(rhythm.limitMs / MIN_MS, "learned"),
    from: "provisional",
    usualMinutes: rhythm.usualMs! / MIN_MS,
    gaps: rhythm.gaps,
    provisional: { moreUpdates: rhythm.moreGaps, moreHours: rhythm.moreMs / 3_600_000 }
  };
}

/**
 * The first rule that applies wins. A source that reports coverage is judged by how far it has been read and by its own
 * rhythm: the owner's expectation, then its learned limit once real, then the collector's declared cadence; after those,
 * the entry's own freshness, the connection, then a provisional learned limit. A coverage source with none of those has no
 * number at all (it is not late; `NodeHealth.noRhythm` says why). Every other source: the entry's own freshness, the
 * connection, learned arrivals, then cold start.
 */
export function thresholdFor(entry: FlowEntry, context: ThresholdContext): ThresholdInUse | null {
  const coverage = context.coverage;
  if (coverage) {
    const real = realCoverageThreshold(coverage);
    if (real) return real;
  }
  const own = entry.freshness;
  if (own !== undefined && own !== "from-connection") {
    return {
      warnHours: own.warnAfterHours,
      errorHours: own.errorAfterHours,
      from: entry.owner !== undefined && entry.owner !== "core" ? "overlay" : "default"
    };
  }
  if (own === "from-connection") {
    const provider = entry.syncProvider ?? (entry.health.kind === "sync-runs" ? entry.health.provider : undefined);
    const late = provider === undefined ? undefined : context.cadenceLateAfterMs?.[provider];
    return late === undefined
      ? null
      : { warnHours: late / HOUR_MS, errorHours: (2 * late) / HOUR_MS, from: "connection" };
  }
  if (coverage) return provisionalCoverageThreshold(coverage.rhythm);
  const pushLike = entry.activitySource !== undefined && entry.method === "push";
  const deviceLike = entry.device !== undefined || entry.health.kind === "json-stamp";
  if (!pushLike && !deviceLike && !entry.coldStart) return null;
  if (context.learned && (pushLike || deviceLike)) return { ...context.learned, from: "learned" };
  if (entry.coldStart)
    return { warnHours: entry.coldStart.warnAfterHours, errorHours: entry.coldStart.errorAfterHours, from: "default" };
  return null;
}

/**
 * One line for `rhen sources <id>`: where a source's late and stale limits come from. A coverage source's reads
 * `limit: late 3 d, stale 6 d (owner: expects every 1 d)`; any other origin keeps the plain warn and error hours.
 */
export function limitLine(threshold: ThresholdInUse): string {
  const span = (hours: number) => formatSpan(hours * HOUR_MS);
  const limits = `late ${span(threshold.warnHours)}${threshold.errorHours === null ? "" : `, stale ${span(threshold.errorHours)}`}`;
  const usual = threshold.usualMinutes === undefined ? "" : formatSpan(threshold.usualMinutes * MIN_MS);
  const changed = threshold.rhythmChanged
    ? `; usual rhythm changed (last gap ${span(threshold.rhythmChanged.lastGapHours)}), not blocking until confirmed`
    : "";
  switch (threshold.from) {
    case "owner":
      return `limit: ${limits} (owner: expects every ${usual})`;
    case "provisional": {
      const more = threshold.provisional;
      const parts = [
        more && more.moreUpdates > 0 ? `${more.moreUpdates} more ${more.moreUpdates === 1 ? "update" : "updates"}` : "",
        more && more.moreHours > 0 ? `${span(more.moreHours)} more history` : ""
      ].filter(Boolean);
      return `limit: ${limits} (provisional: usually every ${usual}, judged on ${threshold.gaps ?? 0} gaps; never blocks, becomes final after ${parts.length > 0 ? parts.join(" and ") : "its next update"})`;
    }
    case "learned":
      if (threshold.gaps === undefined) break;
      return `limit: ${limits} (learned: usually every ${usual}, ${threshold.gaps} gaps${threshold.declaredWarnHours !== undefined ? `; collector declares late ${span(threshold.declaredWarnHours)}` : ""})${changed}`;
    case "collector":
      return `limit: ${limits} (collector declares it${threshold.observedWarnHours !== undefined ? `; its own posts would give late ${span(threshold.observedWarnHours)}` : ""})`;
    default:
      break;
  }
  return `threshold: warn ${threshold.warnHours} h, error ${threshold.errorHours ?? "none"} h (${threshold.from})`;
}

export interface ClassifyInput {
  now: number;
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  lastAttemptOk: boolean | null;
  threshold: { warnHours: number; errorHours: number | null } | null;
}

export function classifyFreshness(input: ClassifyInput): FreshnessState {
  const { now, lastSuccessAt, lastAttemptAt, lastAttemptOk, threshold } = input;
  if (lastAttemptOk === false && lastAttemptAt !== null && (lastSuccessAt === null || lastAttemptAt > lastSuccessAt))
    return "failing";
  if (threshold === null) return "n/a";
  if (lastSuccessAt === null) return "never";
  const ageHours = (now - lastSuccessAt) / HOUR_MS;
  if (threshold.errorHours !== null && ageHours > threshold.errorHours) return "stale";
  return ageHours > threshold.warnHours ? "late" : "fresh";
}

/** A kind of an activity source that stopped arriving on its own learned rhythm while the source as a whole did not. */
export interface LateKind {
  kind: string;
  /** The newest arrival of this kind. */
  lastAt: string;
  /** The warning this kind's own rhythm gave (1.5 x its p95 gap, between 2 h and 14 d). */
  warnHours: number;
}

/** What one probe found, for one entry. */
export interface NodeHealth {
  entryId: string;
  probe: string;
  /** False until there is evidence the source is in use; the page shows grey "not set up". */
  configured: boolean;
  freshness: FreshnessState;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  /** The newest failure, at most 200 characters, untrusted text. */
  lastError: { at: string | null; message: string } | null;
  count24h?: number;
  count7d?: number;
  /** Activity sources: the kinds seen in the last 30 days. */
  kindsSeen?: string[];
  /** Push sources with a learned rhythm: the kinds that went quiet while the source as a whole is still arriving. */
  lateKinds?: LateKind[];
  /** A source that reports coverage: how far it has been read, per scope, and its newest heartbeat. `lastSuccessAt` is `coverage.coveredTo`. */
  coverage?: NodeCoverage;
  /** A coverage source with fewer than 2 gaps and nothing declared: no rhythm yet, so no threshold and nothing is late. */
  noRhythm?: { updates: number; gaps: number };
  /** The source's own agent token exists and is live, used or not; with `never` this is silence, not a source never set up. */
  credentialPresent?: boolean;
  threshold: ThresholdInUse | null;
  /** One line of plain explanation, for a person or an agent. */
  note?: string;
}

export type HealthIssueCode = "probe_unresolved" | "token_not_bound";

/** A problem with the registry or its wiring rather than with the data, with the exact next step. */
export interface HealthIssue {
  code: HealthIssueCode;
  entryId: string;
  tier: "degrading" | "tidy";
  /** What is wrong, in one sentence. */
  title: string;
  /** The exact next step, for the agent that reads it (or for the person, when `who` is `person`). */
  next: string;
  /** `person` when only the owner can act, such as minting a token; absent when an agent's tool call can. */
  who?: "person";
}

export interface DeviceHealth {
  id: string;
  ref: string;
  entries: string[];
  lastSeenAt: string | null;
  /** The entry the last-seen time came from. */
  lastSeenFrom: string | null;
}
