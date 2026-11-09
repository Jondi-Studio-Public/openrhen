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
  /** `learned` (arrivals over 30 days), `connection`, `overlay` (an extension's own number) or `default`. */
  from: "learned" | "connection" | "overlay" | "default";
  /** Days of arrivals a learned threshold rests on; under 30 it may only reach the degrading tier. */
  days?: number;
}

/** Cold-start numbers for a push source with too few arrivals to learn from, by entry id. */
export const COLD_START: Readonly<Record<string, { warnHours: number; errorHours: number | null }>> = {
  "iphone-shortcuts": { warnHours: 24, errorHours: 72 },
  "iphone-health": { warnHours: 36, errorHours: 72 },
  "rhen-watch": { warnHours: 24, errorHours: 72 },
  handheld: { warnHours: 12, errorHours: 48 },
  "phone-location": { warnHours: 48, errorHours: null }
};

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

export interface ThresholdContext {
  /** `doctorSyncCadence()` as provider to late-after milliseconds. */
  cadenceLateAfterMs?: Readonly<Record<string, number>>;
  learned?: { warnHours: number; errorHours: number; days: number } | null;
}

/** The first rule that applies wins: the entry's own freshness, the connection, learned, then cold start. */
export function thresholdFor(entry: FlowEntry, context: ThresholdContext): ThresholdInUse | null {
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
  if (!pushLike && !deviceLike) return null;
  if (context.learned) return { ...context.learned, from: "learned" };
  const cold = COLD_START[entry.id] ?? (entry.device === undefined ? undefined : COLD_START[entry.device]);
  return cold ? { ...cold, from: "default" } : null;
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
  if (threshold === null) return "n/a";
  if (lastAttemptOk === false && lastAttemptAt !== null && (lastSuccessAt === null || lastAttemptAt > lastSuccessAt))
    return "failing";
  if (lastSuccessAt === null) return "never";
  const ageHours = (now - lastSuccessAt) / HOUR_MS;
  if (threshold.errorHours !== null && ageHours > threshold.errorHours) return "stale";
  return ageHours > threshold.warnHours ? "late" : "fresh";
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
  lastError: { at: string; message: string } | null;
  count24h?: number;
  count7d?: number;
  /** Activity sources: the kinds seen in the last 30 days. */
  kindsSeen?: string[];
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
  /** The exact next step, for the agent that reads it. */
  next: string;
}

export interface DeviceHealth {
  id: string;
  ref: string;
  entries: string[];
  lastSeenAt: string | null;
  /** The entry the last-seen time came from. */
  lastSeenFrom: string | null;
}
