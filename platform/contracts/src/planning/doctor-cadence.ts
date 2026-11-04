/**
 * Doctor's cadence checks: routines judged by their own rule, and syncs judged
 * against how often their worker runs them. Pure over a plain slice, like `runDoctor`; the cadence-due math is
 * `cadence-due.ts`, reused and never re-implemented. Status only: no error text, subject or address.
 */
import {
  addLocalDays,
  cadenceEligibleLocalDate,
  dateOrdinal,
  localDateOf,
  type CadenceDueRule
} from "./cadence-due.js";
import type { DoctorItem } from "./doctor.js";
import { calendarSourceConnections } from "../connections/registry.js";
import { mergedRecord, type SyncCadence } from "../extensions.js";
import "../private/index.js";

/** A recurring action with this many missed occurrences in a row is asked about. */
export const DOCTOR_MISSED_RUN_STREAK = 3;
/** A cadence is overdue once it is due and at least this many days past its own next date (and a whole interval). */
export const DOCTOR_CADENCE_OVERDUE_MIN_DAYS = 3;

/**
 * How often each worker runs a calendar source, and how late a last success may be before doctor says so (twice the
 * interval, with a floor so a worker backing off is not flagged). Read from each source's manifest schedule: a daily
 * source runs once a day and is late after two; an interval source runs every `defaultMinutes` and is late after three
 * intervals. A feature the OpenRhen export leaves out adds its own providers through the contracts extension seam
 * (`syncCadence`).
 */
export function calendarSourceCadence(): Record<string, SyncCadence> {
  const cadence: Record<string, SyncCadence> = {};
  for (const manifest of calendarSourceConnections()) {
    const schedule = manifest.calendarSource?.schedule;
    if (!schedule) continue;
    cadence[manifest.id] =
      schedule.kind === "daily"
        ? { intervalMs: 24 * 3_600_000, lateAfterMs: 48 * 3_600_000 }
        : { intervalMs: schedule.defaultMinutes * 60_000, lateAfterMs: 3 * schedule.defaultMinutes * 60_000 };
  }
  return cadence;
}

/** The calendar source cadences plus those the registered extensions add. */
export function doctorSyncCadence(): Readonly<Record<string, SyncCadence>> {
  return { ...calendarSourceCadence(), ...mergedRecord((extension) => extension.syncCadence) };
}

export interface DoctorCadence {
  id: string;
  title: string;
  /** The whole rule `cadence-due.ts` judges; `lastCompletedLocalDate` and `completionLocalDates` come from the log. */
  rule: CadenceDueRule;
}

export interface DoctorRecurringRuns {
  id: string;
  title: string;
  /** Settled occurrences (completed or missed), newest first; pending and cancelled ones are left out. */
  recent: { localDate: string; status: string }[];
}

export interface DoctorSyncCadence {
  provider: string;
  /** The status of the latest run: `synced`, `needs_review`, `failed` or `not_configured`. */
  lastRunStatus: string;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
}

export interface DoctorCadenceSlice {
  cadences: DoctorCadence[];
  recurring: DoctorRecurringRuns[];
  syncs: DoctorSyncCadence[];
}

const HOUR = 3_600_000;

function ms(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t;
}

function ago(from: number, now: number): string {
  const hours = Math.max(0, Math.round((now - from) / HOUR));
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
}

function every(intervalMs: number): string {
  if (intervalMs >= 24 * HOUR) return `${Math.round(intervalMs / (24 * HOUR))} day`;
  if (intervalMs >= HOUR) return `${Math.round(intervalMs / HOUR)} hour`;
  return `${Math.round(intervalMs / 60_000)} minute`;
}

/** The cadence's own cycle length in days: its period, else its interval. */
function cycleDays(rule: CadenceDueRule): number {
  if (rule.period) return rule.period.unit === "month" ? 30 : Math.max(1, rule.period.length);
  return Math.max(1, rule.intervalDays);
}

export function cadenceItems(slice: DoctorCadenceSlice, nowMs: number): DoctorItem[] {
  const items: DoctorItem[] = [];
  const now = new Date(nowMs);

  for (const c of slice.cadences) {
    const today = localDateOf(now, c.rule.timezone);
    const eligible = cadenceEligibleLocalDate(c.rule, today);
    if (eligible > today) continue; // not due yet
    const cycle = cycleDays(c.rule);
    const lastOrStart = c.rule.lastCompletedLocalDate ?? c.rule.startDate;
    const nextOwn = addLocalDays(lastOrStart, cycle);
    const overdueDays = dateOrdinal(today) - dateOrdinal(nextOwn);
    if (overdueDays < Math.max(cycle, DOCTOR_CADENCE_OVERDUE_MIN_DAYS)) continue;
    items.push({
      id: `cadence_overdue:${c.id}`,
      check: "cadence_overdue",
      tier: "degrading",
      area: "routines",
      title: `${c.title} is ${overdueDays} days past its own cadence (every ${cycle} days)`,
      why: "The cadence is due and keeps being offered, but it has gone a whole cycle without being done.",
      handles: [`action:${c.id}`],
      since: `${nextOwn}T00:00:00.000Z`,
      fix: { who: "person", question: `${c.title} is overdue. Keep it, change how often, or drop it?` }
    });
  }

  for (const r of slice.recurring) {
    let streak = 0;
    for (const o of r.recent) {
      if (o.status !== "missed") break;
      streak += 1;
    }
    if (streak < DOCTOR_MISSED_RUN_STREAK) continue;
    const oldest = r.recent[streak - 1]!.localDate;
    items.push({
      id: `routine_missed:${r.id}`,
      check: "routine_missed",
      tier: "degrading",
      area: "routines",
      title: `${r.title} missed ${streak} times in a row`,
      why: "The plan keeps making room for it and it keeps going unused.",
      handles: [`action:${r.id}`],
      since: `${oldest}T00:00:00.000Z`,
      fix: {
        who: "person",
        question: `${r.title} was missed ${streak} times running. Keep it, change how often, or drop it?`
      }
    });
  }

  for (const s of slice.syncs) {
    const cadence = doctorSyncCadence()[s.provider];
    if (!cadence) continue;
    if (s.lastRunStatus !== "synced" && s.lastRunStatus !== "needs_review") continue;
    const last = ms(s.lastSuccessAt);
    if (last === undefined || nowMs - last <= cadence.lateAfterMs) continue;
    items.push({
      id: `sync_late:${s.provider}`,
      check: "sync_late",
      tier: "degrading",
      area: "integrations",
      title: `${s.provider} last synced ${ago(last, nowMs)} ago, later than its usual every ${every(cadence.intervalMs)}`,
      why: "What it brings in may be out of date, so the plan can drift from the real calendar or inbox.",
      handles: [],
      since: s.lastSuccessAt!,
      fix: { who: "person", question: `${s.provider} has not synced on its usual schedule. Is the worker running?` }
    });
  }
  return items;
}
