import {
  DEFAULT_TIMEZONE,
  catchUpDue,
  entriesInWindow,
  groupReentryEntries,
  reentryLeavesOnLedger,
  reentryReviewable,
  reentryTier,
  catchUpNudgeDedupeKey,
  composeCatchUpNudge,
  nextDaytimeDelivery,
  CATCH_UP_OCCURRENCE_LOOKBACK_DAYS,
  CATCH_UP_PAGE_SIZE,
  checkInCatchUpQuestion,
  endsAtPause,
  openSessionTitle,
  resolveFreshness,
  sessionEndQuestion,
  wakeQuestion,
  type ActivityCommand,
  type CatchUpEntry,
  type CatchUpLedger,
  type CatchUpReentry,
  type CatchUpVerdict,
  type CatchUpVerdictName,
  type SessionCommand,
  type SettleCatchUpCommand,
  type SettleCatchUpResult,
  notFoundRefusal,
  refusalText
} from "@openrhen/contracts";
import {
  PUSH_OUTBOX_RETENTION_DAYS,
  userPreferences as userPreferencesTable,
  users as usersTable
} from "@openrhen/database";
import { changeLogActor, requestAgent } from "@/server/agent-actor";
import { isLapsed, readPulseWindow, type PulseWindow } from "@/server/pulse/pulse-reentry";
import { applyActivityCommand } from "./activity-commands";
import { CommandConflictError, InvalidCommandError } from "./command-errors";
import { claimCommandReceipt, commandRequestHash, refuseCommandIdReuse } from "./command-receipt";
import { ensureUser } from "./ensure-user";
import { changedFieldsBefore, holdPlanForecastPublication, recordStateChange } from "./planning-evidence";
import { readSessions } from "./readers/sessions";
import { applySessionCommand } from "./session-commands";
import { applyWakeCommand } from "./wake-command";
import type { LeftJoined, Row } from "./db-row";
import type { PoolSql, Sql, TxSql } from "./sql-pool";
import { WriteSnapshot } from "./write-snapshot";

/**
 * Catch-up after a break. The ledger lists a recurring action's occurrence whose
 * window closed with no outcome, an active project whose date has passed, and what Now's needs list calls
 * stale (an open session past its planned end, a wake older than the awake limit, by `resolveFreshness`'s
 * rule, never a threshold of catch-up's own), plus the check-in still waiting for an answer. Fixed
 * commitments and planned work follow once each has a past-time write to settle with.
 */

type Queryable = Sql;

const CURRENT_KINDS: ReadonlySet<CatchUpEntry["kind"]> = new Set(["open_session", "stale_wake", "check_in"]);
const OCCURRENCE_VERDICTS: CatchUpVerdictName[] = ["done", "skipped", "dropped", "pending"];
const SELF_SET_VERDICTS: CatchUpVerdictName[] = ["done", "skipped", "dropped", "pending"];
const EXTERNAL_VERDICTS: CatchUpVerdictName[] = ["done", "dropped", "pending"];
const WAKE_VERDICTS: CatchUpVerdictName[] = ["done", "pending"];
const CHECK_IN_VERDICTS: CatchUpVerdictName[] = ["done", "skipped", "pending"];

/**
 * What an open session takes. `ended` (stopped, work not finished) means something only for an action or a
 * deliverable; a routine step or a commitment that stopped simply happened, which is `done`.
 */
function sessionVerdicts(targetType: string): CatchUpVerdictName[] {
  return targetType === "action" || targetType === "deliverable"
    ? ["done", "ended", "skipped", "pending"]
    : ["done", "skipped", "pending"];
}

interface OccurrenceRow {
  id: string;
  title: string;
  local_date: string;
  window_ends_at: Date;
  project_id: string;
  project_title: string;
}

interface DeadlineRow {
  id: string;
  title: string;
  version: number;
  internal_deadline_at: Date | null;
  external_deadline_at: Date | null;
}

const DAY_MS = 86_400_000;

/*
 * `write_rows` whose write has no actor that a machine wrote on the person's behalf (an import commit, a
 * location observation, a travel measurement, an externally routed project) are excluded below: they are
 * not the person recording anything, so they must not reset the quiet window.
 */

/** The last moment the person (or a closed catch-up) recorded anything. Null when nothing ever was. */
export async function lastRecordedActivity(sql: Queryable, userId: string): Promise<Date | null> {
  const rows = await sql<{ since: Date | null }[]>`
    SELECT GREATEST(
      (SELECT max(closed_at) FROM catch_up_runs WHERE user_id = ${userId}),
      (SELECT max(ended_at) FROM sessions WHERE user_id = ${userId}),
      (SELECT max(answered_at) FROM check_in WHERE user_id = ${userId}),
      (SELECT max(r.created_at) FROM write_rows r JOIN writes w ON w.id = r.write_id
        WHERE r.user_id = ${userId} AND w.actor IS NULL
        AND r.entity_type NOT IN ('import_batch','current_situation','journey_samples')
        AND NOT (r.entity_type = 'project' AND r.operation = 'route_create'))
    ) AS since`;
  return rows[0]?.since ?? null;
}

/** Every unsettled entry, newest first. Derived on read, so it cannot go stale. */
export async function allEntries(
  sql: Queryable,
  userId: string,
  now: Date,
  since: Date | null
): Promise<CatchUpEntry[]> {
  const floor = since ?? new Date(now.getTime() - CATCH_UP_OCCURRENCE_LOOKBACK_DAYS * DAY_MS);
  const occurrences = await sql<OccurrenceRow[]>`
    SELECT o.id, ac.title, o.local_date::text AS local_date, o.window_ends_at, p.id AS project_id, p.title AS project_title
    FROM action_occurrences o
    JOIN actions ac ON ac.id = o.action_id
    JOIN projects p ON p.id = ac.project_id
    JOIN outcomes oc ON oc.id = p.outcome_id
    JOIN areas ar ON ar.id = oc.area_id
    WHERE ar.user_id = ${userId} AND o.status = 'pending' AND o.window_ends_at < ${now}
      AND o.window_ends_at >= ${floor} AND p.status = 'active' AND ac.status NOT IN ('done','cancelled','archived')
    ORDER BY o.window_ends_at DESC LIMIT 2000`;
  const deadlines = await sql<DeadlineRow[]>`
    SELECT p.id, p.title, p.version, p.internal_deadline_at, p.external_deadline_at
    FROM projects p
    JOIN outcomes oc ON oc.id = p.outcome_id
    JOIN areas ar ON ar.id = oc.area_id
    WHERE ar.user_id = ${userId} AND p.status = 'active'
      AND ((p.external_deadline_at IS NULL AND p.internal_deadline_at < ${now}) OR p.external_deadline_at < ${now})
    ORDER BY COALESCE(p.external_deadline_at, p.internal_deadline_at) DESC LIMIT 500`;
  const entries: CatchUpEntry[] = [
    ...occurrences.map((row) => ({
      id: `occurrence:${row.id}`,
      kind: "occurrence" as const,
      title: row.title,
      plannedAt: row.window_ends_at.toISOString(),
      question: null,
      verdicts: OCCURRENCE_VERDICTS,
      atRequired: [],
      localDate: row.local_date,
      projectId: row.project_id,
      projectTitle: row.project_title,
      version: null
    })),
    ...deadlines.map((row) => {
      const external = row.external_deadline_at !== null;
      return {
        id: `deadline:${row.id}`,
        kind: external ? ("external_deadline" as const) : ("self_set_deadline" as const),
        title: row.title,
        plannedAt: (external ? row.external_deadline_at! : row.internal_deadline_at!).toISOString(),
        question: external ? null : "Date lapsed, still wanted?",
        verdicts: external ? EXTERNAL_VERDICTS : SELF_SET_VERDICTS,
        atRequired: [],
        localDate: null,
        projectId: row.id,
        projectTitle: row.title,
        version: row.version
      };
    })
  ];
  entries.sort((a, b) => (a.plannedAt < b.plannedAt ? 1 : a.plannedAt > b.plannedAt ? -1 : 0));
  // What is wrong right now comes first: Now cannot be trusted until it is settled.
  return [...(await currentEntries(sql, userId, now, floor)), ...entries];
}

/**
 * The open session and the wake when `resolveFreshness` says they are stale, and the latest check-in when it
 * is still open. Only the latest: the check-in design never makes a backlog of missed slots
 * (`readCurrentCheckIn`), and catch-up keeps that rule rather than asking about every one he slept through.
 */
async function currentEntries(sql: Queryable, userId: string, now: Date, floor: Date): Promise<CatchUpEntry[]> {
  const entries: CatchUpEntry[] = [];
  const { activeSession } = await readSessions(sql, userId, now);
  const prefs = await sql<
    { max_awake_hours: number; last_woke_at: Date | null; version: number }[]
  >`SELECT max_awake_hours, last_woke_at, version FROM user_preferences WHERE user_id=${userId}`;
  const lastWokeAt = prefs[0]?.last_woke_at?.toISOString();
  const freshness = resolveFreshness(
    {
      settings: { maxAwakeHours: prefs[0]?.max_awake_hours ?? 18, ...(lastWokeAt ? { lastWokeAt } : {}) },
      activeSession,
      currentSituation: { locationId: null }
    },
    now
  );
  if (activeSession && freshness.session.stale && freshness.session.asOf) {
    // The session's own action row: `actionId` on the wire is the occurrence id for a recurring action.
    const actions = activeSession.targetTitle
      ? []
      : (
          await sql<
            { title: string }[]
          >`SELECT ac.title FROM sessions se JOIN actions ac ON ac.id=se.action_id WHERE se.id=${activeSession.id}`
        ).map((row) => ({ id: activeSession.targetId || activeSession.actionId, title: row.title }));
    const targetType = activeSession.targetType ?? "action";
    entries.push({
      id: `session:${activeSession.id}`,
      kind: "open_session",
      title: openSessionTitle(activeSession, actions),
      plannedAt: freshness.session.asOf,
      question: sessionEndQuestion(activeSession, now),
      verdicts: sessionVerdicts(targetType),
      ...(targetType === "action" ? { asksRemainingMinutes: true as const } : {}),
      // A paused session stopped when it was paused, and still did once it awaits feedback: its pause is the end.
      atRequired: endsAtPause(activeSession) ? [] : ["done", "ended"],
      localDate: null,
      projectId: null,
      version: activeSession.version ?? null
    });
  }
  if (freshness.wake.stale && freshness.wake.asOf)
    entries.push({
      id: "wake",
      kind: "stale_wake",
      title: "Last wake",
      plannedAt: freshness.wake.asOf,
      question: wakeQuestion(freshness.wake.asOf, now),
      verdicts: WAKE_VERDICTS,
      atRequired: ["done"],
      localDate: null,
      projectId: null,
      version: prefs[0]?.version ?? null
    });
  const checkIn = await sql<
    { id: string; version: number; slot_at: Date; directive_title: string; status: string; answered_at: Date | null }[]
  >`SELECT id, version, slot_at, directive_title, status, answered_at FROM check_in WHERE user_id=${userId} ORDER BY slot_at DESC LIMIT 1`;
  const latest = checkIn[0];
  if (
    latest &&
    latest.slot_at >= floor &&
    (latest.status === "pending" || (latest.status === "unknown" && latest.answered_at === null))
  )
    entries.push({
      id: `check-in:${latest.id}`,
      kind: "check_in",
      title: latest.directive_title,
      plannedAt: latest.slot_at.toISOString(),
      question: checkInCatchUpQuestion(latest.directive_title, latest.slot_at.toISOString(), now),
      verdicts: CHECK_IN_VERDICTS,
      atRequired: [],
      localDate: null,
      projectId: null,
      version: latest.version
    });
  return entries;
}

export interface CatchUpQuery {
  /** Narrow to entries from this moment on; default is the occurrence look-back and every lapsed date. */
  since?: Date | undefined;
  offset?: number | undefined;
  now?: Date | undefined;
}

/** The pulse window's tiered grouping; only while the pulse is lapsed. */
export function buildReentryBlock(
  pulse: PulseWindow,
  entries: CatchUpEntry[],
  now: Date,
  timeZone: string
): { block: CatchUpReentry; inWindow: CatchUpEntry[] } {
  const gapMinutes = pulse.lastConfirmedAt
    ? Math.max(0, (now.getTime() - pulse.lastConfirmedAt.getTime()) / 60_000)
    : null;
  // Never confirmed: nothing to measure, so the widest review.
  const tier = gapMinutes === null ? "projects" : reentryTier(gapMinutes);
  const inWindow = entriesInWindow(entries, pulse.lastConfirmedAt);
  const groups = groupReentryEntries(inWindow, tier, timeZone);
  return {
    inWindow,
    block: {
      tier,
      lastConfirmedAt: pulse.lastConfirmedAt?.toISOString() ?? null,
      gapMinutes,
      reviewable: inWindow.filter(reentryReviewable).length,
      lapsing: inWindow.filter((entry) => !reentryReviewable(entry) && !reentryLeavesOnLedger(entry)).length,
      days: groups.days.map((group) => ({ day: group.day, entryIds: group.entries.map((entry) => entry.id) })),
      projects: groups.projects.map((group) => ({
        projectId: group.projectId,
        title: group.title,
        entryIds: group.entries.map((entry) => entry.id)
      }))
    }
  };
}

export async function userTimeZone(sql: Queryable, userId: string): Promise<string> {
  const rows = await sql<{ timezone: string }[]>`SELECT timezone FROM users WHERE id=${userId}`;
  return rows[0]?.timezone ?? DEFAULT_TIMEZONE;
}

export interface CatchUpDue {
  due: boolean;
  /** The pulse says the person lapsed (the first reason `due` can be true). */
  lapsed: boolean;
  pulse: PulseWindow | null;
  since: Date | null;
  unsettled: number;
}

/**
 * Whether the catch-up is due, with no write: the pulse's lapse first, else the quiet-hours rule over the unsettled
 * entries. The ledger read calls this and then cancels held nudges when not due; a read-only caller (the attention
 * feed) calls it alone and so never cancels one. `since` and `entries` may be passed when the caller already read
 * them (the ledger reads `entries` narrowed by its own `since` query, so they are not recomputed here).
 */
export async function readCatchUpDue(
  sql: Queryable,
  userId: string,
  now: Date,
  known: { since?: Date | null; entries?: readonly CatchUpEntry[] } = {}
): Promise<CatchUpDue> {
  const since = known.since !== undefined ? known.since : await lastRecordedActivity(sql, userId);
  const entries = known.entries ?? (await allEntries(sql, userId, now, null));
  // Due is the pulse's call first (it is `off/lapsed`); the 36 hour rule stays as the fallback for a pulse that
  // never lapsed (a user the recorder has not evaluated, or one whose pulse stayed on while nothing was recorded).
  const pulse = await readPulseWindow(sql, userId);
  const lapsed = isLapsed(pulse);
  return { due: lapsed || catchUpDue(since, entries.length, now), lapsed, pulse, since, unsettled: entries.length };
}

export async function readCatchUpLedger(sql: Queryable, query: CatchUpQuery = {}): Promise<CatchUpLedger> {
  const userId = await ensureUser(sql);
  const now = query.now ?? new Date();
  const since = await lastRecordedActivity(sql, userId);
  // Deadlines are not narrowed by `since`: a date that lapsed long ago is still stale.
  const entries = await allEntries(sql, userId, now, query.since ?? null);
  const offset = Math.max(0, query.offset ?? 0);
  // The right-now entries come and go with the clock, so they ride on the first page alone and never shift
  // the offsets the dated entries page by.
  const current = entries.filter((entry) => CURRENT_KINDS.has(entry.kind));
  const dated = entries.filter((entry) => !CURRENT_KINDS.has(entry.kind));
  const datedPage = dated.slice(offset, offset + CATCH_UP_PAGE_SIZE);
  const page = offset === 0 ? [...current, ...datedPage] : datedPage;
  // Due is the pulse's call first (it is `off/lapsed`); the 36 hour rule stays as the fallback for a pulse that
  // never lapsed (a user the recorder has not evaluated, or one whose pulse stayed on while nothing was recorded).
  const { due, lapsed, pulse } = await readCatchUpDue(sql, userId, now, { since, entries });
  const reentry =
    lapsed && pulse ? buildReentryBlock(pulse, entries, now, await userTimeZone(sql, userId)).block : undefined;
  // Someone is back (or nothing is left): a nudge still held for the wake time would be stale.
  if (!due) await cancelCatchUpNudges(sql, userId);
  return {
    now: now.toISOString(),
    since: since?.toISOString() ?? null,
    due,
    ...(reentry ? { reentry } : {}),
    unsettled: entries.length,
    staleDates: entries.filter((entry) => entry.kind === "self_set_deadline").length,
    entries: page,
    remaining: Math.max(0, dated.length - offset - datedPage.length),
    nextOffset: offset + datedPage.length < dated.length ? offset + datedPage.length : null
  };
}

/**
 * How many entries are unsettled right now: exactly the ledger's `unsettled` (the same `allEntries`), with no
 * write, so a read-only caller (the data health check) never cancels a held nudge as a side effect.
 */
export async function countCatchUpUnsettled(sql: Queryable, userId: string, now: Date): Promise<number> {
  return (await allEntries(sql, userId, now, null)).length;
}

/** When to deliver: the sweep runs at night, so the push waits for the person's wake time (`nextDaytimeDelivery`). */
async function daytimeDelivery(sql: Queryable, userId: string, now: Date): Promise<Date> {
  const [row] = await sql<
    (Row<typeof usersTable, "timezone"> &
      LeftJoined<Row<typeof userPreferencesTable, "preferred_wake_time" | "planning_horizon_end">>)[]
  >`
    SELECT u.timezone, p.preferred_wake_time, p.planning_horizon_end
    FROM users u LEFT JOIN user_preferences p ON p.user_id = u.id WHERE u.id = ${userId}`;
  return row ? nextDaytimeDelivery(now, row.timezone, row.preferred_wake_time, row.planning_horizon_end) : now;
}

/**
 * Cancels a nudge still waiting for the wake time once its away window is over (activity resumed, or everything
 * settled), so the phone never announces things to settle after Catch-up is empty. A native-app transport's
 * mirror follows the web push row's cancellation (its drop-in drain).
 */
export async function cancelCatchUpNudges(sql: Queryable, userId: string): Promise<void> {
  await sql`UPDATE push_outbox SET status='cancelled'
    WHERE user_id=${userId} AND status='pending' AND dedupe_key LIKE 'catch-up-due:%'`;
}

/** A queued push stays deliverable this long if the phone is away, as the weekly reviewer's does. */
const NUDGE_PUSH_TTL_DAYS = 3;

/**
 * Queues the one "your plan is waiting" push for the current away window, from the plan-map sweep. Due-ness
 * is the ledger's (`catchUpDue`); a person who has never recorded anything has no window and is not nudged.
 * The window's start is the dedupe key, so later sweeps in the same absence add nothing.
 */
export async function queueCatchUpNudge(
  sql: Queryable,
  userId: string,
  now: Date = new Date()
): Promise<{ due: boolean; queued: boolean }> {
  const since = await lastRecordedActivity(sql, userId);
  if (!since) return { due: false, queued: false };
  const unsettled = (await allEntries(sql, userId, now, null)).length;
  if (!catchUpDue(since, unsettled, now)) {
    await cancelCatchUpNudges(sql, userId);
    return { due: false, queued: false };
  }
  // The window's own row is the dedupe record, and the outbox prune deletes it after PUSH_OUTBOX_RETENTION_DAYS;
  // a window older than that less the push's life was nudged long ago, so it is not nudged again.
  if (now.getTime() - since.getTime() > (PUSH_OUTBOX_RETENTION_DAYS - NUDGE_PUSH_TTL_DAYS - 1) * DAY_MS)
    return { due: true, queued: false };
  const dedupeKey = catchUpNudgeDedupeKey(since);
  const payload = { ...composeCatchUpNudge(since, unsettled, now), tag: dedupeKey, url: "/catch-up" };
  const deliverAt = await daytimeDelivery(sql, userId, now);
  // `test` is the outbox kind whose check constraint needs no migration; the drain path is generic.
  const queued = await sql`
    INSERT INTO push_outbox (user_id, dedupe_key, kind, payload, status, next_attempt_at, expires_at)
    VALUES (${userId}, ${dedupeKey}, 'test', ${sql.json(payload as never)}, 'pending', ${deliverAt},
      ${new Date(deliverAt.getTime() + NUDGE_PUSH_TTL_DAYS * DAY_MS)})
    ON CONFLICT (user_id, dedupe_key, channel) DO NOTHING
    RETURNING id`;
  return { due: true, queued: queued.length > 0 };
}

export type EntryVerdict = Extract<CatchUpVerdict, { entryId: string }>;

/** Bulk shortcuts become per-entry verdicts, so history and undo see individual rows. */
function expandVerdicts(verdicts: CatchUpVerdict[], entries: CatchUpEntry[], now: Date): EntryVerdict[] {
  const out: EntryVerdict[] = [];
  for (const verdict of verdicts) {
    if (!("bulk" in verdict)) {
      out.push(verdict);
      continue;
    }
    if (verdict.bulk === "skip_older_than") {
      // The whole window, whatever was listed on any page: everything a plain skip can settle.
      const before = now.getTime() - verdict.days * DAY_MS;
      for (const entry of entries)
        if (
          (entry.kind === "occurrence" || entry.kind === "self_set_deadline" || entry.kind === "check_in") &&
          new Date(entry.plannedAt).getTime() < before
        )
          out.push({ entryId: entry.id, verdict: "skipped" });
      continue;
    }
    const dropped = verdict.bulk === "all_dropped";
    for (const entry of entries) {
      if (verdict.projectId && entry.projectId !== verdict.projectId) continue;
      if (verdict.day && entry.localDate !== verdict.day) continue;
      if (entry.kind === "occurrence") out.push({ entryId: entry.id, verdict: dropped ? "dropped" : "skipped" });
      else if (dropped && verdict.projectId) out.push({ entryId: entry.id, verdict: "dropped", becomes: "paused" });
    }
  }
  return out;
}

export interface Applied {
  outcome: "applied" | "unchanged" | "conflict" | "invalid";
  message?: string;
  before?: Record<string, unknown> | null;
  /**
   * `activity_session`: ended through the activity command, which closes routine steps, step actions, occurrences
   * and cadence rows no snapshot holds, so a settle carrying one is not kept for undo.
   */
  kind?: "occurrence" | "project" | "session" | "activity_session" | "wake" | "check_in";
}

function refuseFutureOrMissingAt(
  verdict: EntryVerdict,
  required: boolean,
  now: Date,
  missing: string
): Applied | Date | undefined {
  if (!verdict.at) return required ? { outcome: "invalid", message: missing } : undefined;
  const at = new Date(verdict.at);
  if (at.getTime() > now.getTime()) return { outcome: "invalid", message: "That time is in the future." };
  return at;
}

/**
 * A forgotten session, ended through the session or activity command itself (inside a savepoint, so a
 * refusal leaves the rest of the settle standing), so a settle and a finish cannot end a session two ways.
 */
async function settleSession(
  tx: TxSql,
  userId: string,
  sessionId: string,
  verdict: EntryVerdict,
  now: Date,
  snap: WriteSnapshot | null,
  commandId: string
): Promise<Applied> {
  const rows = await tx<
    {
      status: string;
      target_type: string;
      version: number;
      ended_at: Date | null;
      paused_remaining_seconds: number | null;
    }[]
  >`SELECT status, target_type, version, ended_at, paused_remaining_seconds FROM sessions WHERE id=${sessionId} AND user_id=${userId} FOR UPDATE`;
  const row = rows[0];
  if (!row) return { outcome: "invalid", message: refusalText(notFoundRefusal("session", sessionId)) };
  if (row.ended_at !== null || !["running", "paused", "awaiting_feedback"].includes(row.status))
    return { outcome: "conflict", message: "It was already ended." };
  if (verdict.version !== undefined && verdict.version !== null && verdict.version !== row.version)
    return { outcome: "conflict", message: "The session was changed elsewhere." };
  if (!sessionVerdicts(row.target_type).includes(verdict.verdict))
    return {
      outcome: "invalid",
      message: `A ${row.target_type.replace("_", " ")} session cannot be ${verdict.verdict}.`
    };
  if (verdict.verdict === "pending") return { outcome: "unchanged" };
  if (verdict.remainingMinutes !== undefined && (row.target_type !== "action" || verdict.verdict !== "ended"))
    return { outcome: "invalid", message: "Only an action session that ended takes the minutes left." };
  // The ledger's rule (`endsAtPause`), on the stored row: a paused session, or one that went on to await feedback.
  const paused = endsAtPause({
    status: row.status === "awaiting_feedback" ? "feedback" : row.status === "paused" ? "paused" : "running",
    ...(row.paused_remaining_seconds !== null ? { pausedRemainingSeconds: row.paused_remaining_seconds } : {})
  } as Parameters<typeof endsAtPause>[0]);
  if (paused && verdict.at)
    return { outcome: "invalid", message: "A paused session stopped when it was paused; settle it without a time." };
  const at = refuseFutureOrMissingAt(
    verdict,
    !paused && verdict.verdict !== "skipped",
    now,
    "Say when it stopped (`at`)."
  );
  if (at && !(at instanceof Date)) return at;
  const endedAt = at?.toISOString();
  const base = { commandId, sessionId, expectedVersion: row.version };
  try {
    await tx.savepoint(async (sp) => {
      if (row.target_type === "action") {
        const command: SessionCommand =
          verdict.verdict === "skipped"
            ? { ...base, type: "did_not_start" }
            : verdict.verdict === "done"
              ? { ...base, type: "finish", outcome: "completed", ...(endedAt ? { endedAt } : {}) }
              : verdict.remainingMinutes !== undefined
                ? {
                    ...base,
                    type: "finish",
                    outcome: "progress",
                    remainingMinutes: verdict.remainingMinutes,
                    ...(endedAt ? { endedAt } : {})
                  }
                : { ...base, type: "finish", outcome: "unsure", ...(endedAt ? { endedAt } : {}) };
        await applySessionCommand(sp, userId, command, snap, { endAtPause: paused });
      } else {
        const outcome =
          verdict.verdict === "done" ? "completed" : verdict.verdict === "ended" ? "stopped" : "did_not_start";
        const command: ActivityCommand = {
          ...base,
          type: "finish_activity",
          outcome,
          ...(endedAt ? { endedAt } : {})
        };
        await applyActivityCommand(sp, userId, command, null, { endAtPause: paused });
      }
    });
  } catch (error) {
    if (error instanceof InvalidCommandError) return { outcome: "invalid", message: error.message };
    if (error instanceof CommandConflictError) return { outcome: "conflict", message: error.message };
    throw error;
  }
  return {
    outcome: "applied",
    kind: row.target_type === "action" ? "session" : "activity_session",
    before: { id: sessionId, status: row.status, ended_at: null }
  };
}

/**
 * The last wake, said again, through the wake verb (`applyWakeCommand`, wake-command.ts) inside a savepoint: a running
 * sleep finishes at it, or last night's planned sleep is completed with it, or the wake alone is recorded. So a
 * settle and `rhen wake --at` cannot record a morning differently.
 */
async function settleWake(
  tx: TxSql,
  userId: string,
  verdict: EntryVerdict,
  now: Date,
  commandId: string,
  snap: WriteSnapshot | null
): Promise<Applied> {
  const rows = await tx<
    { last_woke_at: Date | null; version: number }[]
  >`SELECT last_woke_at, version FROM user_preferences WHERE user_id=${userId} FOR UPDATE`;
  const row = rows[0];
  if (!row) return { outcome: "invalid", message: "There are no settings to record a wake in." };
  if (!WAKE_VERDICTS.includes(verdict.verdict))
    return { outcome: "invalid", message: "The wake is settled with when the person woke (`done` with `at`)." };
  if (verdict.version !== undefined && verdict.version !== null && verdict.version !== row.version)
    return { outcome: "conflict", message: "Settings were changed elsewhere." };
  if (verdict.verdict === "pending") return { outcome: "unchanged" };
  const at = refuseFutureOrMissingAt(verdict, true, now, "Say when the person woke (`at`).");
  if (!(at instanceof Date)) return at ?? { outcome: "invalid" };
  if (row.last_woke_at && at.getTime() <= row.last_woke_at.getTime())
    return { outcome: "invalid", message: "That is not after the wake already recorded." };
  try {
    await tx.savepoint(async (sp) => {
      await applyWakeCommand(sp, userId, { commandId, type: "wake", at: at.toISOString() }, now, snap);
    });
  } catch (error) {
    if (error instanceof InvalidCommandError) return { outcome: "invalid", message: error.message };
    if (error instanceof CommandConflictError) return { outcome: "conflict", message: error.message };
    throw error;
  }
  return { outcome: "applied", kind: "wake", before: { last_woke_at: row.last_woke_at?.toISOString() ?? null } };
}

/**
 * The open check-in: `done` is on track, `skipped` is "not sure" (answered, so it stops asking). The same row
 * writes `answer_check_in` makes; a deviated answer with a category goes through that command.
 */
async function settleCheckIn(
  tx: TxSql,
  userId: string,
  checkInId: string,
  verdict: EntryVerdict,
  snap: WriteSnapshot | null
): Promise<Applied> {
  const rows = await tx<
    { version: number; status: string; answered_at: Date | null }[]
  >`SELECT version, status, answered_at FROM check_in WHERE id=${checkInId} AND user_id=${userId} FOR UPDATE`;
  const row = rows[0];
  if (!row) return { outcome: "invalid", message: refusalText(notFoundRefusal("check-in", checkInId)) };
  if ((row.status !== "pending" && row.status !== "unknown") || row.answered_at !== null)
    return { outcome: "conflict", message: "It was already answered." };
  if (verdict.version !== undefined && verdict.version !== null && verdict.version !== row.version)
    return { outcome: "conflict", message: "The check-in changed elsewhere." };
  if (!CHECK_IN_VERDICTS.includes(verdict.verdict))
    return { outcome: "invalid", message: "A check-in is on track (`done`), not sure (`skipped`) or still open." };
  if (verdict.verdict === "pending") return { outcome: "unchanged" };
  await snap?.before("check_in", [checkInId]);
  await tx`UPDATE check_in SET status=${verdict.verdict === "done" ? "on_track" : "unknown"}, answered_at=CURRENT_TIMESTAMP, answer_source='sheet', answered_by=${requestAgent()}, version=version+1, updated_at=CURRENT_TIMESTAMP WHERE id=${checkInId}`;
  return { outcome: "applied", kind: "check_in", before: { id: checkInId, status: row.status, answered_at: null } };
}

export async function settleOccurrence(
  tx: Queryable,
  userId: string,
  id: string,
  verdict: EntryVerdict,
  now: Date,
  snap: WriteSnapshot | null
): Promise<Applied> {
  const rows = await tx<
    { status: string; window_ends_at: Date; before: Record<string, unknown> }[]
  >`SELECT o.status, o.window_ends_at, to_jsonb(o) AS before FROM action_occurrences o JOIN actions ac ON ac.id = o.action_id JOIN projects p ON p.id = ac.project_id JOIN outcomes oc ON oc.id = p.outcome_id JOIN areas ar ON ar.id = oc.area_id WHERE o.id = ${id} AND ar.user_id = ${userId} FOR UPDATE OF o`;
  const row = rows[0];
  if (!row) return { outcome: "invalid", message: refusalText(notFoundRefusal("occurrence", id)) };
  if (row.status !== "pending") return { outcome: "conflict", message: `It was already settled as ${row.status}.` };
  if (!OCCURRENCE_VERDICTS.includes(verdict.verdict))
    return { outcome: "invalid", message: `An occurrence cannot be ${verdict.verdict}.` };
  if (verdict.verdict === "pending") return { outcome: "unchanged" };
  if (verdict.verdict === "done") {
    const at = verdict.at ? new Date(verdict.at) : row.window_ends_at;
    if (at.getTime() > now.getTime())
      return { outcome: "invalid", message: "A completion time cannot be in the future." };
    await snap?.before("action_occurrences", [id]);
    await tx`UPDATE action_occurrences SET status='completed', completed_at=${at}, updated_at=CURRENT_TIMESTAMP WHERE id=${id}`;
  } else {
    const status = verdict.verdict === "skipped" ? "missed" : "cancelled";
    await snap?.before("action_occurrences", [id]);
    await tx`UPDATE action_occurrences SET status=${status}, updated_at=CURRENT_TIMESTAMP WHERE id=${id}`;
  }
  return { outcome: "applied", kind: "occurrence", before: { id, status: row.status, completed_at: null } };
}

export async function settleDeadline(
  tx: Queryable,
  userId: string,
  projectId: string,
  verdict: EntryVerdict,
  now: Date,
  snap: WriteSnapshot | null
): Promise<Applied> {
  const rows = await tx<
    {
      version: number;
      status: string;
      internal_deadline_at: Date | null;
      external_deadline_at: Date | null;
      before: Record<string, unknown>;
    }[]
  >`SELECT p.version, p.status, p.internal_deadline_at, p.external_deadline_at, to_jsonb(p) AS before FROM projects p JOIN outcomes oc ON oc.id = p.outcome_id JOIN areas ar ON ar.id = oc.area_id WHERE p.id = ${projectId} AND ar.user_id = ${userId} FOR UPDATE OF p`;
  const row = rows[0];
  if (!row) return { outcome: "invalid", message: refusalText(notFoundRefusal("project", projectId)) };
  const external = row.external_deadline_at !== null;
  const date = external ? row.external_deadline_at : row.internal_deadline_at;
  if (row.status !== "active" || !date || date.getTime() >= now.getTime())
    return { outcome: "conflict", message: "The project or its date changed since the ledger was read." };
  if (verdict.version !== undefined && verdict.version !== null && verdict.version !== row.version)
    return { outcome: "conflict", message: "The project was changed elsewhere." };
  if (!(external ? EXTERNAL_VERDICTS : SELF_SET_VERDICTS).includes(verdict.verdict) && verdict.verdict !== "skipped")
    return { outcome: "invalid", message: `A date cannot be ${verdict.verdict}.` };
  if (verdict.verdict === "pending" && !verdict.moveTo) return { outcome: "unchanged" };

  let update: "done" | "paused" | "clear" | "move";
  if (verdict.verdict === "done") update = "done";
  else if (verdict.verdict === "dropped") update = verdict.becomes ?? "paused";
  else if (verdict.verdict === "skipped") {
    if (external)
      return {
        outcome: "invalid",
        message: "An external date cannot be dropped: move it, or mark the project done or paused."
      };
    update = "clear";
  } else update = "move";

  if (update === "move") {
    const moveTo = new Date(verdict.moveTo!);
    if (moveTo.getTime() <= now.getTime())
      return { outcome: "invalid", message: "The new date must be in the future." };
    await snap?.before("projects", [projectId]);
    if (external)
      await tx`UPDATE projects SET external_deadline_at=${moveTo}, version=version+1, updated_at=CURRENT_TIMESTAMP WHERE id=${projectId}`;
    else
      await tx`UPDATE projects SET internal_deadline_at=${moveTo}, version=version+1, updated_at=CURRENT_TIMESTAMP WHERE id=${projectId}`;
  } else if (update === "clear") {
    await snap?.before("projects", [projectId]);
    await tx`UPDATE projects SET internal_deadline_at=NULL, version=version+1, updated_at=CURRENT_TIMESTAMP WHERE id=${projectId}`;
  } else if (update === "done") {
    const at = verdict.at ? new Date(verdict.at) : now;
    if (at.getTime() > now.getTime())
      return { outcome: "invalid", message: "A completion time cannot be in the future." };
    await snap?.before("projects", [projectId]);
    await tx`UPDATE projects SET status='done', completed_at=${at}, version=version+1, updated_at=CURRENT_TIMESTAMP WHERE id=${projectId}`;
  } else {
    await snap?.before("projects", [projectId]);
    await tx`UPDATE projects SET status='paused', version=version+1, updated_at=CURRENT_TIMESTAMP WHERE id=${projectId}`;
  }
  const after = await tx<
    { after: Record<string, unknown> }[]
  >`SELECT to_jsonb(p) AS after FROM projects p WHERE p.id=${projectId}`;
  return { outcome: "applied", kind: "project", before: changedFieldsBefore(row.before, after[0]?.after) };
}

/**
 * Settles a batch of verdicts in one transaction and one recalculation, through the one write path.
 * Each entry succeeds or conflicts on its own; the window closes only when nothing remains. Owner path:
 * an agent's settle is stored as a proposal and replayed here when the person confirms it.
 */
export async function settleCatchUp(
  sql: PoolSql,
  command: SettleCatchUpCommand,
  now: Date = new Date()
): Promise<SettleCatchUpResult> {
  const userId = await ensureUser(sql);
  const requestHash = commandRequestHash("settle_catch_up", command);
  const replay = async (queryable: Queryable): Promise<SettleCatchUpResult | null> => {
    const prior = await queryable<
      { response: Partial<SettleCatchUpResult>; command_type: string; request_hash: string | null }[]
    >`SELECT response, command_type, request_hash FROM writes WHERE id=${command.commandId} AND user_id=${userId}`;
    if (!prior[0]) return null;
    refuseCommandIdReuse(prior[0], { commandType: "settle_catch_up", requestHash });
    // The original outcomes, so a retry after a lost response sees what happened, not an empty list.
    const stored = prior[0].response;
    const ledger = await readCatchUpLedger(queryable, { now });
    return {
      results: stored.results ?? [],
      closed: stored.closed ?? false,
      remaining: ledger.unsettled,
      ...(stored.revertible === false ? { revertible: false as const } : {})
    };
  };
  const earlier = await replay(sql);
  if (earlier) return earlier;
  return sql.begin(async (tx) => {
    if (
      !(await claimCommandReceipt(tx, { id: command.commandId, userId, commandType: "settle_catch_up", requestHash }))
    )
      return (await replay(tx)) ?? { results: [], closed: false, remaining: 0 };
    // An agent's settle keeps the rows it changes, so it can be undone afterwards.
    const snap = await WriteSnapshot.open(tx, userId, command.commandId, "catch_up");
    // Publication lock before any row lock, in the worker's order: a settled wake or session writes the sleep
    // and session rows its publish locks. An agent's snapshot takes it too; the person's settle takes it here.
    if (!snap) await holdPlanForecastPublication(tx, userId);
    const since = await lastRecordedActivity(tx, userId);
    const entries = await allEntries(tx, userId, now, null);
    const verdicts = expandVerdicts(command.verdicts, entries, now);
    const results: SettleCatchUpResult["results"] = [];
    const beforeOccurrences: unknown[] = [];
    const beforeProjects: unknown[] = [];
    const beforeOther: unknown[] = [];
    const seen = new Set<string>();
    let revertible = true;
    for (const verdict of verdicts) {
      if (seen.has(verdict.entryId)) {
        results.push({
          entryId: verdict.entryId,
          outcome: "invalid",
          message: "That entry appears twice in this settle."
        });
        continue;
      }
      seen.add(verdict.entryId);
      const [kind, ...rest] = verdict.entryId.split(":");
      const id = rest.join(":");
      const applied: Applied =
        kind === "occurrence"
          ? await settleOccurrence(tx, userId, id, verdict, now, snap)
          : kind === "deadline"
            ? await settleDeadline(tx, userId, id, verdict, now, snap)
            : kind === "session"
              ? await settleSession(tx, userId, id, verdict, now, snap, command.commandId)
              : kind === "wake" && id === ""
                ? await settleWake(tx, userId, verdict, now, command.commandId, snap)
                : kind === "check-in"
                  ? await settleCheckIn(tx, userId, id, verdict, snap)
                  : { outcome: "invalid", message: "Unknown entry id." };
      results.push({
        entryId: verdict.entryId,
        outcome: applied.outcome,
        ...(applied.message ? { message: applied.message } : {})
      });
      if (applied.outcome === "applied" && applied.kind === "activity_session") revertible = false;
      if (applied.outcome === "applied")
        (applied.kind === "occurrence"
          ? beforeOccurrences
          : applied.kind === "project"
            ? beforeProjects
            : beforeOther
        ).push(applied.before ?? null);
    }
    const appliedCount = results.filter((result) => result.outcome === "applied").length;
    const remaining = (await allEntries(tx, userId, now, null)).length;
    // A settle means the person is back: the held "your plan is waiting" push has done its job.
    await cancelCatchUpNudges(tx, userId);
    const closed = command.closeWindow && remaining === 0;
    if (closed) {
      const run = await tx<
        { id: string }[]
      >`INSERT INTO catch_up_runs (user_id, window_since, window_until, closed_by, counts)
        VALUES (${userId}, ${since}, ${now}, ${changeLogActor()}, ${tx.json({ applied: appliedCount, total: results.length } as never)})
        RETURNING id::text AS id`;
      snap?.inserted(
        "catch_up_runs",
        run.map((row) => row.id)
      );
    }
    if (appliedCount > 0 || closed) {
      if (revertible) await snap?.save();
      await recordStateChange(tx, userId, {
        entityType: "catch_up",
        entityId: command.commandId,
        operation: "settle",
        commandId: command.commandId,
        before: { occurrences: beforeOccurrences, projects: beforeProjects, current: beforeOther },
        evidence: {
          applied: appliedCount,
          results: results.map((result) => ({ entryId: result.entryId, outcome: result.outcome })),
          basis: command.basis,
          ...(command.evidence ? { statedEvidence: command.evidence } : {}),
          ...(command.note ? { note: command.note } : {}),
          closed
        },
        at: now
      });
    }
    const kept = revertible ? {} : { revertible: false as const };
    await tx`UPDATE writes SET response=${tx.json({ results, closed, ...kept } as never)}, updated_at=now() WHERE id=${command.commandId}`;
    return { results, closed, remaining, ...kept };
  });
}
