import { COVERAGE_DEFAULT_WARN_HOURS, COVERAGE_STALE_FACTOR, type NodeCoverage } from "./coverage.js";
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
   * `owner` (the owner's own setting, a source that reports coverage), `collector` (the cadence the collector declares),
   * `learned` (arrivals over 30 days), `connection`, `overlay` (an extension's own number) or `default`.
   */
  from: "owner" | "collector" | "learned" | "connection" | "overlay" | "default";
  /** Days of arrivals a learned threshold rests on. The reader only reports it. Nothing in this reader limits a threshold under 30 days to the degrading tier; the doctor source checks (a later change) are where that rule belongs. */
  days?: number;
}

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
  /** The owner's `staleAfterMinutes` for the source; absent or null means none is set (the setting arrives in a later change). */
  ownerStaleAfterMinutes?: number | null;
  /** The cadence the collector declared in its registry entry's availability. */
  collector?: { expectedEveryMinutes?: number; silentAfterMinutes?: number } | null;
}

export interface ThresholdContext {
  /** `doctorSyncCadence()` as provider to late-after milliseconds. */
  cadenceLateAfterMs?: Readonly<Record<string, number>>;
  learned?: { warnHours: number; errorHours: number; days: number } | null;
  coverage?: CoverageThresholdContext;
}

/** T for a source that states how far behind it may be: late at T, stale at 2T. */
const behind = (minutes: number, from: "owner" | "collector"): ThresholdInUse => ({
  warnHours: minutes / 60,
  errorHours: (COVERAGE_STALE_FACTOR * minutes) / 60,
  from
});

/** T from the owner's setting, else from the collector's declared cadence; null when neither is stated. */
function statedCoverageThreshold(coverage: CoverageThresholdContext): ThresholdInUse | null {
  const owner = coverage.ownerStaleAfterMinutes;
  if (typeof owner === "number" && owner > 0) return behind(owner, "owner");
  const declared = coverage.collector;
  if (declared?.silentAfterMinutes !== undefined && declared.silentAfterMinutes > 0)
    return behind(declared.silentAfterMinutes, "collector");
  if (declared?.expectedEveryMinutes !== undefined && declared.expectedEveryMinutes > 0)
    return behind(3 * declared.expectedEveryMinutes, "collector");
  return null;
}

/**
 * The first rule that applies wins. A source that reports coverage is judged by how far it has read, so the owner's
 * number and then the collector's declared cadence come first; after that, for every source, the entry's own freshness,
 * the connection, learned, then cold start. A coverage source with none of those is read late at 12 h behind, stale at 24 h.
 */
export function thresholdFor(entry: FlowEntry, context: ThresholdContext): ThresholdInUse | null {
  const coverage = context.coverage;
  if (coverage) {
    const stated = statedCoverageThreshold(coverage);
    if (stated) return stated;
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
  const pushLike = entry.activitySource !== undefined && entry.method === "push";
  const deviceLike = entry.device !== undefined || entry.health.kind === "json-stamp";
  if (!pushLike && !deviceLike && !entry.coldStart && !coverage) return null;
  if (context.learned && (pushLike || deviceLike || coverage)) return { ...context.learned, from: "learned" };
  if (entry.coldStart)
    return { warnHours: entry.coldStart.warnAfterHours, errorHours: entry.coldStart.errorAfterHours, from: "default" };
  return coverage
    ? {
        warnHours: COVERAGE_DEFAULT_WARN_HOURS,
        errorHours: COVERAGE_STALE_FACTOR * COVERAGE_DEFAULT_WARN_HOURS,
        from: "default"
      }
    : null;
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
