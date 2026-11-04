import {
  DEFAULT_TIMEZONE,
  DEFAULT_LOCATION_STALE_AFTER_MINUTES,
  leaveByPrompts,
  type CommitmentTimelineWire,
  type LeaveByCommitment,
  type LeaveByLeg,
  type Underway
} from "@openrhen/contracts";
import type postgres from "postgres";
import {
  assumedOriginCopy,
  dueCopy,
  earlierCopy,
  leaveByDedupeKey,
  leaveByTag,
  reminderCopy,
  retractionCopy
} from "./leave-by-copy.js";

/**
 * The worker-facing half of leave-by:
 * a pure decision table (`decideLeaveByTick`) over the outbox's own history, plus the one DB-touching
 * tick (`runLeaveByTick`) that reads state, calls it, and enqueues. Mirrors `check-in-scheduler.ts`'s
 * shape — stateless across ticks, idempotent by construction (the outbox's unique `(user_id,
 * dedupe_key)` is what actually enforces it; this function only ever asks "is there already a row?").
 */

/** How far beyond the origin a single unambiguous reading must sit to count as departed on its own. */
export const AWAY_MARGIN_METERS = 150;

export interface ExistingOutboxRow {
  kind: "reminder" | "assumed_origin" | "earlier" | "due" | "test";
  announcedLeaveBy: Date | null;
  status: "pending" | "sent" | "cancelled" | "expired" | "failed";
  /** Needed to tell a retraction (stored as kind `earlier`, key `...:cancelled`) from a real earlier prompt. */
  dedupeKey?: string;
}

/**
 * A retraction replaces an already-delivered prompt (same tag) after its leg was cancelled or moved.
 * It is stored under kind `earlier` because `push_outbox_kind_check` has no value for it and this
 * change adds no migration; its dedupe key ends `:cancelled`, which is what identifies it.
 */
export function isRetractionRow(row: ExistingOutboxRow): boolean {
  return Boolean(row.dedupeKey?.endsWith(":cancelled"));
}

export type LeaveByAction =
  | { type: "enqueue"; kind: "reminder"; dedupeKey: string; expiresAt: Date }
  | { type: "enqueue"; kind: "assumed_origin"; dedupeKey: string; expiresAt: Date }
  | { type: "enqueue"; kind: "earlier"; dedupeKey: string; expiresAt: Date; minutesEarlier: number }
  | { type: "enqueue"; kind: "due"; dedupeKey: string; expiresAt: Date }
  | { type: "enqueue"; kind: "retract"; reason: "cancelled" | "moved"; dedupeKey: string; expiresAt: Date }
  | { type: "cancel_pending" }
  | { type: "none" };

/** A row counts toward "already sent this slot" whatever its outcome — sent, pending or even failed exhaustion. */
function hasRow(existing: readonly ExistingOutboxRow[], kinds: readonly string[]): ExistingOutboxRow | undefined {
  return existing.find((row) => kinds.includes(row.kind) && row.status !== "cancelled" && row.status !== "expired");
}

/**
 * One leg's decision, from `leaveByPrompts`'s own phase/suppression plus this occurrence's existing
 * outbox rows (the leave by push design note, the decision table under "The prompt rules"). Never
 * more than one action per tick — the caller applies it, and the outbox's unique constraint is the
 * actual backstop against a double enqueue.
 */
export function decideLeaveByTick(leg: LeaveByLeg, allExisting: readonly ExistingOutboxRow[]): LeaveByAction {
  const expiresAt = new Date(leg.leaveBy.getTime() + 5 * 60_000);
  const existing = allExisting.filter((row) => !isRetractionRow(row));

  if (leg.phase === "done" || leg.suppressedBy) {
    if (existing.some((row) => row.status === "pending")) return { type: "cancel_pending" };
    // A prompt that already reached the lock screen is not undone by cancelling queued rows: replace
    // it (same tag) once, so a cancelled or moved leg does not leave a stale "leave by" showing.
    if (
      (leg.suppressedBy === "cancelled" || leg.suppressedBy === "moved") &&
      existing.some((row) => row.status === "sent" && row.kind !== "test") &&
      !allExisting.some((row) => isRetractionRow(row) && row.status !== "cancelled" && row.status !== "expired")
    ) {
      return {
        type: "enqueue",
        kind: "retract",
        reason: leg.suppressedBy,
        dedupeKey: leaveByDedupeKey(leg.commitmentId, leg.occurrenceStartsAt, "cancelled"),
        expiresAt
      };
    }
    return { type: "none" };
  }

  const leadRow = hasRow(existing, ["reminder", "assumed_origin"]);
  // After downtime that ends past `leaveBy`, the lead reminder and the due prompt would arrive a tick
  // apart for the same leg. In the leave phase with a confirmed origin, the due prompt says it all.
  const skipLead = leg.phase === "leave" && !leg.originAssumed;
  if ((leg.phase === "remind" || leg.phase === "leave") && !leadRow && !skipLead) {
    return leg.originAssumed
      ? {
          type: "enqueue",
          kind: "assumed_origin",
          dedupeKey: leaveByDedupeKey(leg.commitmentId, leg.occurrenceStartsAt, "lead"),
          expiresAt
        }
      : {
          type: "enqueue",
          kind: "reminder",
          dedupeKey: leaveByDedupeKey(leg.commitmentId, leg.occurrenceStartsAt, "lead"),
          expiresAt
        };
  }

  if (
    (leg.phase === "remind" || leg.phase === "leave") &&
    leadRow?.announcedLeaveBy &&
    !hasRow(existing, ["earlier"])
  ) {
    const minutesEarlier = Math.round((leadRow.announcedLeaveBy.getTime() - leg.leaveBy.getTime()) / 60_000);
    if (minutesEarlier >= 5) {
      return {
        type: "enqueue",
        kind: "earlier",
        dedupeKey: leaveByDedupeKey(leg.commitmentId, leg.occurrenceStartsAt, "earlier"),
        expiresAt,
        minutesEarlier
      };
    }
  }

  if (leg.phase === "leave" && !leg.originAssumed && !hasRow(existing, ["due"])) {
    return {
      type: "enqueue",
      kind: "due",
      dedupeKey: leaveByDedupeKey(leg.commitmentId, leg.occurrenceStartsAt, "due"),
      expiresAt
    };
  }

  return { type: "none" };
}

export interface DeviceObservationForEvidence {
  observedAt: Date;
  /** The matched location id, or null when the reading matched nothing or was ambiguous. */
  matchedLocationId: string | null;
  accuracyMeters: number;
  /** Only the phone is departure evidence: a browser reading comes from whatever machine has a tab open. */
  source: "phone" | "browser";
  /** True when the reading sat inside two or more saved places, which says nothing about the origin. */
  ambiguous?: boolean;
}

/**
 * Readings coarser than this (cell-tower or IP fixes) are not evidence of anything about the origin.
 * Looser than the 500 m cap for *asserting* a place on purpose: a fix that matches no saved place at
 * 1000 m still means the origin is at least that far from the true position, whereas a matching fix
 * has to be tight to prove the person is *at* that place.
 */
export const MAX_EVIDENCE_ACCURACY_METERS = 1000;

/** A stored entry whose source is missing or unrecognised is treated as `browser`, so it never counts as departure evidence. */
export function evidenceSourceOf(value: unknown): DeviceObservationForEvidence["source"] {
  return value === "phone" ? "phone" : "browser";
}

/**
 * Unambiguous device evidence of having left `originId` since `since` (the leave by push design note,
 * "Underway"): one observation matched to a *different* known place, or two consecutive observations
 * that both fail to match the origin. A single unmatched reading with tight accuracy also counts on
 * its own — `matchNearestLocation` (`portal/server/location/nearest-location.ts`) already requires
 * every candidate, origin included, to be beyond `matchToleranceMeters(accuracy)` for a reading to
 * come back unmatched at all, so a tight fix (accuracy no worse than {@link AWAY_MARGIN_METERS}) that
 * still matched nothing is already the "beyond radius + margin from the origin" the design calls for;
 * a sloppy one is not, and only counts once a second one in a row agrees.
 */
export function observationsAwayFromOrigin(
  observations: readonly DeviceObservationForEvidence[],
  originId: string,
  since: Date
): boolean {
  const inWindow = observations
    .filter(
      (o) =>
        o.source === "phone" &&
        !o.ambiguous &&
        o.accuracyMeters <= MAX_EVIDENCE_ACCURACY_METERS &&
        o.observedAt.getTime() >= since.getTime()
    )
    .sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  const failsOrigin = (o: DeviceObservationForEvidence) => o.matchedLocationId !== originId;

  for (let i = 0; i < inWindow.length; i += 1) {
    const observation = inWindow[i]!;
    if (observation.matchedLocationId !== null && observation.matchedLocationId !== originId) return true;
    if (observation.matchedLocationId === null && observation.accuracyMeters <= AWAY_MARGIN_METERS) return true;
  }
  for (let i = 0; i + 1 < inWindow.length; i += 1) {
    if (failsOrigin(inWindow[i]!) && failsOrigin(inWindow[i + 1]!)) return true;
  }
  return false;
}

interface RawCurrentSituation {
  locationId: string | null;
  locationSetAt?: string;
  underway?: Underway | null;
}

function situationStale(locationSetAt: string | undefined, now: Date): boolean {
  if (!locationSetAt) return true;
  const ageMinutes = (now.getTime() - new Date(locationSetAt).getTime()) / 60_000;
  return ageMinutes > DEFAULT_LOCATION_STALE_AFTER_MINUTES;
}

/**
 * Runs one user's leave-by tick against the real database: reads the latest plan's
 * `commitmentTimelines`, the named commitments, the situation and device trail, and the lead-time
 * setting; calls `leaveByPrompts`, then `decideLeaveByTick` per leg; applies each action.
 * `runLeaveByTick`'s own SQL owns the per-user read — the worker calls this once per tick.
 */
export async function runLeaveByTick(sql: postgres.Sql, userId: string, now: Date): Promise<void> {
  const planRows = await sql<{ result: { derivedState?: { commitmentTimelines?: CommitmentTimelineWire[] } } }[]>`
    SELECT result FROM planning_runs WHERE user_id=${userId} AND superseded_at IS NULL
    ORDER BY calculated_at DESC LIMIT 1
  `;
  const timelines = planRows[0]?.result?.derivedState?.commitmentTimelines ?? [];
  if (!timelines.length) return;

  const prefRows = await sql<
    {
      leave_by_lead_minutes: number;
      current_situation: RawCurrentSituation | null;
      device_location_state: { observations?: unknown[] } | null;
    }[]
  >`
    SELECT leave_by_lead_minutes, current_situation, device_location_state FROM user_preferences WHERE user_id=${userId}
  `;
  const prefs = prefRows[0];
  if (!prefs) return;
  const situation: RawCurrentSituation = prefs.current_situation ?? { locationId: null };
  const leadMinutes = prefs.leave_by_lead_minutes ?? 10;

  const rawObservations = Array.isArray(prefs.device_location_state?.observations)
    ? (prefs.device_location_state!.observations as Record<string, unknown>[])
    : [];
  const observations: DeviceObservationForEvidence[] = rawObservations
    .map((entry): DeviceObservationForEvidence | null => {
      const match = entry.match as { kind?: string; locationId?: string } | undefined;
      const source = evidenceSourceOf(entry.source);
      const observedAt = typeof entry.observedAt === "string" ? new Date(entry.observedAt) : null;
      const accuracyMeters = typeof entry.accuracyMeters === "number" ? entry.accuracyMeters : Number.POSITIVE_INFINITY;
      if (!observedAt) return null;
      return {
        observedAt,
        accuracyMeters,
        source,
        ambiguous: match?.kind === "ambiguous",
        matchedLocationId: match?.kind === "matched" && typeof match.locationId === "string" ? match.locationId : null
      };
    })
    .filter((entry): entry is DeviceObservationForEvidence => entry !== null);

  const commitmentIds = [...new Set(timelines.map((timeline) => timeline.id))];
  const commitmentRows = commitmentIds.length
    ? await sql<{ id: string; starts_at: Date; status: string; title: string; attendance: string }[]>`
        SELECT id, starts_at, status, title, attendance FROM commitments WHERE user_id=${userId} AND id IN ${sql(commitmentIds)}
      `
    : [];
  const commitments: LeaveByCommitment[] = commitmentRows.map((row) => ({
    id: row.id,
    startsAt: row.starts_at.toISOString(),
    status: row.status,
    title: row.title,
    attendance: row.attendance
  }));

  const legs = leaveByPrompts({
    timelines,
    commitments,
    situation: {
      locationId: situation.locationId,
      locationSetAt: situation.locationSetAt ?? null,
      stale: situationStale(situation.locationSetAt, now),
      underway: situation.underway ?? null
    },
    observationsAwayFromOrigin: (originId, since) => observationsAwayFromOrigin(observations, originId, since),
    leadMinutes,
    now
  });

  const assumedLocationName = legs.some((leg) => leg.originAssumed)
    ? await resolveAssumedLocationName(sql, userId, situation.locationId)
    : "home";

  for (const leg of legs) {
    // A moved leg's prompts were announced under the occurrence the plan still holds, not the
    // commitment's new start, so that is the occurrence (and tag) to look up and to retract.
    const announcedOccurrence =
      leg.suppressedBy === "moved"
        ? (timelines.find((timeline) => timeline.id === leg.commitmentId)?.startsAt ?? leg.occurrenceStartsAt)
        : leg.occurrenceStartsAt;
    const announcedLeg =
      announcedOccurrence === leg.occurrenceStartsAt ? leg : { ...leg, occurrenceStartsAt: announcedOccurrence };
    const existingRows = await sql<
      {
        kind: ExistingOutboxRow["kind"];
        announced_leave_by: Date | null;
        status: ExistingOutboxRow["status"];
        dedupe_key: string;
      }[]
    >`
      SELECT kind, announced_leave_by, status, dedupe_key FROM push_outbox
      WHERE user_id=${userId} AND channel='webpush' AND commitment_id=${leg.commitmentId}
        AND occurrence_starts_at=${announcedOccurrence}
    `;
    const existing: ExistingOutboxRow[] = existingRows.map((row) => ({
      kind: row.kind,
      announcedLeaveBy: row.announced_leave_by,
      status: row.status,
      dedupeKey: row.dedupe_key
    }));
    const action = decideLeaveByTick(announcedLeg, existing);
    await applyLeaveByAction(sql, userId, announcedLeg, action, now, assumedLocationName);
  }
}

const TIME_ZONE_FALLBACK = DEFAULT_TIMEZONE;

/**
 * The assumed-origin push's own wording: the last
 * place ever said, or home when nothing has ever been said — the same rule the Now travel panel's
 * "Yes, I'm here" button reads (`travel-panel.tsx`'s `assumedLocationName`).
 */
async function resolveAssumedLocationName(
  sql: postgres.Sql,
  userId: string,
  situationLocationId: string | null
): Promise<string> {
  const homeRows = await sql<{ home_location_id: string | null }[]>`
    SELECT home_location_id FROM user_preferences WHERE user_id=${userId}
  `;
  const assumedId = situationLocationId ?? homeRows[0]?.home_location_id ?? null;
  if (!assumedId) return "home";
  const placeRows = await sql<{ name: string }[]>`
    SELECT name FROM condition_definitions WHERE user_id=${userId} AND id=${assumedId}
  `;
  return placeRows[0]?.name ?? "home";
}

async function applyLeaveByAction(
  sql: postgres.Sql,
  userId: string,
  leg: LeaveByLeg,
  action: LeaveByAction,
  now: Date,
  assumedLocationName: string
): Promise<void> {
  if (action.type === "cancel_pending") {
    await sql`
      UPDATE push_outbox SET status='cancelled'
      WHERE user_id=${userId} AND commitment_id=${leg.commitmentId} AND occurrence_starts_at=${leg.occurrenceStartsAt}
        AND status='pending' AND dedupe_key NOT LIKE '%:cancelled'
    `;
    return;
  }
  if (action.type === "none") return;

  const timezoneRows = await sql<{ timezone: string | null }[]>`SELECT timezone FROM users WHERE id=${userId}`;
  const timeZone = timezoneRows[0]?.timezone ?? TIME_ZONE_FALLBACK;
  const tag = leaveByTag(leg.commitmentId, leg.occurrenceStartsAt);
  const url = "/now";

  let title: string;
  let body: string;
  switch (action.kind) {
    case "reminder": {
      const copy = reminderCopy(leg, timeZone);
      title = copy.title;
      body = copy.body;
      break;
    }
    case "assumed_origin": {
      const copy = assumedOriginCopy(leg, assumedLocationName, timeZone);
      title = copy.title;
      body = copy.body;
      break;
    }
    case "earlier": {
      const copy = earlierCopy(leg, action.minutesEarlier, timeZone);
      title = copy.title;
      body = copy.body;
      break;
    }
    case "retract": {
      const copy = retractionCopy(leg, action.reason);
      title = copy.title;
      body = copy.body;
      break;
    }
    case "due": {
      const copy = dueCopy(leg, new Date(leg.occurrenceStartsAt), timeZone);
      title = copy.title;
      body = copy.body;
      break;
    }
  }

  // `renotify` re-alerts over an on-screen replacement (design "On-screen replacement"): required for
  // the at-leave-by ("due") and leave-earlier ("earlier") prompts, since each replaces a reminder the
  // person may already have dismissed. The lead reminder itself has nothing earlier to replace.
  const renotify = action.kind === "due" || action.kind === "earlier" ? true : undefined;
  const payload = { title, body, tag, url, ...(renotify ? { renotify } : {}) };
  const announcedLeaveBy = action.kind === "reminder" || action.kind === "assumed_origin" ? leg.leaveBy : null;
  const storedKind = action.kind === "retract" ? "earlier" : action.kind;

  await sql`
    INSERT INTO push_outbox
      (user_id, dedupe_key, kind, payload, commitment_id, occurrence_starts_at, announced_leave_by, status, expires_at, created_at)
    VALUES (${userId}, ${action.dedupeKey}, ${storedKind}, ${sql.json(payload as never)}, ${leg.commitmentId},
      ${leg.occurrenceStartsAt}, ${announcedLeaveBy}, 'pending', ${action.expiresAt}, ${now})
    ON CONFLICT (user_id, dedupe_key, channel) DO NOTHING
  `;
}
