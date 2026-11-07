import { createHash } from "node:crypto";
import {
  DEFAULT_LOCATION_STALE_AFTER_MINUTES,
  leaveByPrompts,
  resolveNowActivity,
  settingsLocale,
  shownTargetFor,
  type ActivityCommand,
  type LeaveByCommitment,
  type LeaveByLeg,
  type NowActivityResolution,
  type NowProtectedInfo,
  type PlanningEntityCommand,
  type SessionCommand,
  type ShownTarget
} from "@openrhen/contracts";
import { stableUuid } from "@/server/persistence/postgres/command-values";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { readCurrentCheckIn } from "@/server/persistence/postgres/readers/check-in-read";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";
import type { ActiveSession, PortalState } from "@/state/portal-state";
import { clock } from "@/features/now/now-formatting";

/**
 * The mini Now page an ESP32 handheld shows, and the one place both `GET /api/device/now` and
 * `POST /api/device/action` derive it from. The device asks a much smaller question than the browser
 * does — "what's the one thing on the clock, and what button does something" — so this reduces the
 * answer to the handful of fields a tiny screen needs.
 *
 * It does not decide that answer. `planning/now-activity.ts` in contracts does, for the browser and the device
 * alike; this module used to hold a hand-written subset of those rules and drifted from them (it had
 * no running-late branch at all, and no in-window fallback, so a stale directive dropped it silently
 * to the engine's primary recommendation). What is left here is the wire: view builders, field
 * budgets, the ETag, and what a button press means.
 *
 * The wire contract itself — every field, its budget, the precedence guarantee, and the polling and
 * ETag rules the firmware relies on — is the design notes.
 */

/**
 * Every text field on the wire is pre-truncated to this many characters. The handheld draws one
 * short line per field and has no room to reflow: truncating on the device instead would put the
 * definition of "too long" in two places, to disagree the moment either changed. It happens once,
 * here, and the device draws what it is given.
 */
export const DEVICE_TEXT_BUDGET = 40;
const ELLIPSIS = "...";

/**
 * `value` cut to `budget` **code points** at a word boundary, with an ASCII ellipsis when anything was
 * dropped — ASCII rather than `…` because a small embedded font is not guaranteed to carry the
 * character, and a missing glyph reads as corruption. The result is never longer than `budget` code
 * points, ellipsis included. A single word longer than the budget is cut mid-word rather than
 * vanishing.
 *
 * Sliced with `Array.from` rather than `.slice`/`.length`, which count UTF-16 code *units*: a title
 * carrying an emoji or any other character outside the Basic Multilingual Plane is one code point but
 * two code units, so a unit-based cut landing between the two halves of its surrogate pair produced an
 * unpaired surrogate — which serializes to JSON fine but renders as a corrupt glyph (or nothing) on
 * the device. Code points are what "40 characters" means to a human reading the string.
 */
export function fitDeviceText(value: string, budget: number = DEVICE_TEXT_BUDGET): string {
  const text = value.trim().replace(/\s+/g, " ");
  const codePoints = Array.from(text);
  if (codePoints.length <= budget) return text;
  const room = budget - ELLIPSIS.length;
  const cut = codePoints.slice(0, room);
  // A cut that lands exactly on a space already ends on a word boundary; backing up to the previous
  // space there would throw away a whole word that fits.
  const lastSpace = codePoints[room] === " " ? room : cut.lastIndexOf(" ");
  const headPoints = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  const head = headPoints.join("").replace(/[\s,;:.\-–—]+$/u, "");
  return `${head || cut.join("")}${ELLIPSIS}`;
}

/** The `ETag` header value for a snapshot: an opaque entity-tag, quoted as RFC 9110 requires. */
export function deviceETag(stateVersion: string): string {
  return `"${stateVersion}"`;
}

/**
 * Whether an `If-None-Match` header names this snapshot. Quotes and any `W/` weakening prefix are
 * stripped before comparing, and a comma-separated list is accepted: a proxy is entitled to weaken a
 * strong ETag, and comparing the raw header would silently defeat the 304 path — the whole reason a
 * battery device polls at all.
 */
export function deviceETagMatches(header: string | null, stateVersion: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  return header
    .split(",")
    .map((entry) => entry.trim().replace(/^W\//i, "").replace(/^"|"$/g, ""))
    .includes(stateVersion);
}

type ActivityPhase = "setup" | "travel" | "arrival" | "active" | "transition" | "return";

/** The one part of the stored recommendation JSON this device cares about, after `hydrateJson`. */
interface DeviceProtectedCommitment {
  id: string;
  title: string;
  phase: ActivityPhase;
  startsAt: Date;
  endsAt: Date;
  protectedStartAt: Date;
  protectedEndAt: Date;
  phaseStartsAt: Date;
  phaseEndsAt: Date;
  late?: boolean;
}
interface DeviceCandidate {
  /** A deliverable is ranked as `deliverable:<id>`; `deliverableId` is the real id its directive names. */
  action: { id: string; title: string; deliverableId?: string };
  recommendedMinutes: number | null;
  recommendedWallClockMinutes?: number | null;
}
interface DeviceRecommendation {
  primary: DeviceCandidate | null;
  protectedCommitment?: DeviceProtectedCommitment;
}

/**
 * A copy of `hydrateJson` from `portal/state/portal-provider.tsx` (not imported: that module is
 * `"use client"`, and server code stays out of the client graph). The stored recommendation is plain
 * JSON with ISO date strings; this is the same walk that turns them back into `Date`s.
 */
function hydrateJson<T>(value: unknown): T | null {
  if (value === undefined || value === null) return null;
  return JSON.parse(JSON.stringify(value), (_key, item) =>
    typeof item === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(item) ? new Date(item) : item
  ) as T;
}

export type DeviceActivityKind = "session" | "commitment" | "routine_step" | "travel" | "sleep" | "recommended";

export interface DeviceActivity {
  kind: DeviceActivityKind;
  id: string;
  title: string;
  startsAt: number | null;
  endsAt: number | null;
  countdown: boolean;
}

export interface DeviceSnapshot {
  serverTime: number;
  stateVersion: string;
  /**
   * Whether the plan everything below was read from is still current — the engine's own `status`,
   * and a `validUntil` that has not passed. False means the device is showing the last plan the
   * server produced rather than a live one, which is a different thing from having nothing to show.
   * Hashed into `stateVersion` deliberately: it flips only when a plan expires or a new one lands,
   * so it costs no ETag churn and the device wakes on the flip.
   */
  planFresh: boolean;
  activity: DeviceActivity | null;
  late: { isLate: boolean; lateByMin: number };
  tracking: { active: boolean; paused: boolean; kind: "none" | "session" | "commitment"; id: string | null };
  arrival: { pending: boolean; commitmentId: string | null; label: string | null };
  checkIn: { pending: boolean; promptId: string | null; question: string | null };
  next: { title: string; startsAt: number } | null;
  actions: { canStart: boolean; canStop: boolean; canArrive: boolean; onMyWay: boolean; atOrigin: boolean };
  nextChangeAt: number | null;
  leaveBy: DeviceLeaveBy | null;
  /**
   * The earliest future `remindAt` or `leaveBy` among today's eligible, unsuppressed legs, whatever
   * their phase — so a sleeping device can arm a timer wake for a leg it has not been shown yet, not
   * only for the one already on screen.
   */
  wakeAt: number | null;
}

export type DeviceCheckIn = DeviceSnapshot["checkIn"];

/**
 * The leave-by banner: present while a leg from the pure
 * `leaveByPrompts` (`platform/contracts/src/planning/leave-by.ts`) is in `remind` or `leave` and not
 * suppressed. The countdown to `leaveAt` is drawn by the device itself; only the instant crosses the
 * wire.
 */
export interface DeviceLeaveBy {
  commitmentId: string;
  title: string;
  leaveAt: number;
  phase: "remind" | "leave";
  assumedOrigin: boolean;
  originLabel: string | null;
}

/**
 * The one check-in worth surfacing, read the same way `GET /api/check-ins/current` does. Kept
 * outside `buildDeviceSnapshot` so that module stays pure — this is the only I/O either route needs
 * beyond the state store, and it fails soft: no `DATABASE_URL`, or any other read failure, answers
 * "nothing pending" rather than taking the whole snapshot down with it.
 */
export async function readDeviceCheckIn(): Promise<DeviceCheckIn> {
  const none: DeviceCheckIn = { pending: false, promptId: null, question: null };
  const connectionString = databaseUrl();
  if (!connectionString) return none;
  try {
    const sql = sqlPool(connectionString);
    const userId = await ensureUser(sql);
    const checkIn = await readCurrentCheckIn(sql, userId);
    if (!checkIn || checkIn.status !== "pending") return none;
    // Truncated here rather than at the view builders like the rest: this field is read straight out
    // of the check-in row and never passes through `buildDeviceSnapshot`'s own builders.
    return { pending: true, promptId: checkIn.id, question: fitDeviceText(`Still on ${checkIn.directiveTitle}?`) };
  } catch {
    return none;
  }
}

/**
 * The shared resolution, told which types the device carries through it: its own hydrated protected
 * commitment and its own candidate shape come back out of the union unchanged, so nothing here has
 * to widen or re-narrow what the stored recommendation held.
 */
type ProtectedInfo = NowProtectedInfo<DeviceProtectedCommitment>;
type ActivityResolution = NowActivityResolution<DeviceCandidate, DeviceProtectedCommitment>;

/** Only for `tracking`, which reports a running session whether or not it won the moment. */
function isSessionActive(session: ActiveSession | null): session is ActiveSession {
  return session !== null && (session.status === "running" || session.status === "paused");
}

function buildLate(info: ProtectedInfo | undefined, now: Date): DeviceSnapshot["late"] {
  if (!info) return { isLate: false, lateByMin: 0 };
  const isLate = Boolean(info.protectedCommitment.late);
  const lateByMin = isLate
    ? Math.max(0, Math.round((now.getTime() - new Date(info.commitment.startsAt).getTime()) / 60_000))
    : 0;
  return { isLate, lateByMin };
}

/** Mirrors `ArrivalButton` (`components/situation-panel.tsx`): pending only while the commitment
 * names a place and the current situation has not asserted it yet. */
function buildArrival(state: PortalState, info: ProtectedInfo | undefined): DeviceSnapshot["arrival"] {
  const none: DeviceSnapshot["arrival"] = { pending: false, commitmentId: null, label: null };
  if (!info || !info.commitment.locationId) return none;
  if (state.currentSituation.locationId === info.commitment.locationId) return none;
  const definition = state.conditionDefinitions.find((item) => item.id === info.commitment.locationId);
  const label = fitDeviceText(`I'm at ${definition?.name ?? info.commitment.location ?? info.commitment.title}`);
  return { pending: true, commitmentId: info.commitment.id, label };
}

/** When the directive's work (or the journey to it) is still inside its break, that break's end. */
function breakEndsAt(state: PortalState, now: Date, isShown: (directive: ShownDirective) => boolean): Date | null {
  const directive = state.planning?.result?.currentDirective as ShownDirective | null | undefined;
  // Only the break of the thing actually shown: another item's break is not this one's.
  if (!directive || !isShown(directive)) return null;
  const at = directive.notBefore ? new Date(directive.notBefore) : null;
  return at && at > now ? at : null;
}

type ShownDirective = { kind: string; targetId?: string; toLocationId?: string; notBefore?: string };

/** "Break until 10:15 am · Essay", starting when the break ends, the way Now and status say it. */
function afterBreak(
  state: PortalState,
  title: string,
  now: Date,
  isShown: (directive: ShownDirective) => boolean
): Pick<DeviceActivity, "title" | "startsAt"> {
  const until = breakEndsAt(state, now, isShown);
  return until
    ? {
        title: fitDeviceText(
          `Break until ${clock(until, state.settings.timezone, false, settingsLocale(state.settings))} · ${title}`
        ),
        startsAt: until.getTime()
      }
    : { title: fitDeviceText(title), startsAt: null };
}

function buildActivityView(state: PortalState, resolution: ActivityResolution, now: Date): DeviceActivity | null {
  switch (resolution.kind) {
    case "session": {
      const { session } = resolution;
      const occurrence = state.occurrences.find((item) => item.id === session.actionId);
      const action = state.actions.find((item) => item.id === (occurrence?.actionId ?? session.actionId));
      return {
        kind: "session",
        id: session.id,
        title: fitDeviceText(session.targetTitle ?? action?.title ?? "Session"),
        startsAt: new Date(session.startedAt).getTime(),
        endsAt: new Date(session.plannedEndAt).getTime(),
        countdown: session.status === "running"
      };
    }
    case "commitment": {
      const { commitment } = resolution;
      return {
        kind: "commitment",
        id: commitment.id,
        title: fitDeviceText(commitment.title),
        startsAt: new Date(commitment.startsAt).getTime(),
        endsAt: new Date(commitment.endsAt).getTime(),
        countdown: true
      };
    }
    case "routine_step": {
      const { step } = resolution;
      const stepCommitment = state.commitments.find((item) => item.id === step.commitmentId);
      const endsAtIso = step.scheduledEndAt ?? stepCommitment?.endsAt ?? null;
      return {
        kind: "routine_step",
        id: step.id,
        title: fitDeviceText(step.title),
        startsAt: step.scheduledStartAt ? new Date(step.scheduledStartAt).getTime() : null,
        endsAt: endsAtIso ? new Date(endsAtIso).getTime() : null,
        countdown: endsAtIso !== null
      };
    }
    case "travel": {
      const { directive } = resolution;
      return {
        kind: "travel",
        id: directive.toLocationId,
        ...afterBreak(
          state,
          directive.title,
          now,
          (shown) => shown.kind === "travel" && shown.toLocationId === directive.toLocationId
        ),
        endsAt: null,
        countdown: false
      };
    }
    case "sleep": {
      const { plan } = resolution;
      return {
        kind: "sleep",
        id: plan.id,
        title: "Sleep",
        startsAt: new Date(plan.plannedStartAt).getTime(),
        endsAt: new Date(plan.plannedWakeAt).getTime(),
        countdown: true
      };
    }
    case "recommended": {
      const { candidate } = resolution;
      return {
        kind: "recommended",
        id: candidate.action.id,
        ...afterBreak(
          state,
          candidate.action.title,
          now,
          (shown) =>
            (shown.kind === "action" || shown.kind === "deliverable") &&
            shown.targetId === (candidate.action.deliverableId ?? candidate.action.id)
        ),
        endsAt: null,
        countdown: false
      };
    }
    case "free":
      return null;
  }
}

function buildTrackingView(state: PortalState): DeviceSnapshot["tracking"] {
  const { activeSession: session } = state;
  if (!isSessionActive(session)) return { active: false, paused: false, kind: "none", id: null };
  return {
    active: true,
    paused: session.status === "paused",
    kind: session.targetType === "fixed_commitment" ? "commitment" : "session",
    id: session.id
  };
}

/**
 * Minutes left in the phase `planStartCommand` would track a "commitment" resolution against, before
 * any flooring — shared with `planStartCommand` itself so `canStart` and what a tap actually does
 * never disagree about a phase whose window has already elapsed (see `planStartCommand`'s "blocked").
 */
function commitmentPhaseRawMinutes(protectedCommitment: DeviceProtectedCommitment, now: Date): number {
  const phaseEnd =
    protectedCommitment.phase === "active" ? protectedCommitment.protectedEndAt : protectedCommitment.phaseEndsAt;
  return Math.round((phaseEnd.getTime() - now.getTime()) / 60_000);
}

function buildActionsView(
  resolution: ActivityResolution,
  arrival: DeviceSnapshot["arrival"],
  leaveBy: DeviceLeaveBy | null,
  now: Date,
  originKnown: boolean
): DeviceSnapshot["actions"] {
  const canStart =
    resolution.kind === "routine_step" ||
    resolution.kind === "recommended" ||
    (resolution.kind === "commitment" && commitmentPhaseRawMinutes(resolution.protectedCommitment, now) >= 1);
  return {
    canStart,
    canStop: resolution.kind === "session",
    canArrive: arrival.pending,
    // On my way departs from a place; a leg whose origin is unknown has none to depart from.
    onMyWay: leaveBy !== null && !leaveBy.assumedOrigin && originKnown,
    atOrigin: leaveBy !== null && leaveBy.originLabel !== null
  };
}

/**
 * `!== "cancelled"`, matching `nextCommitment` (`features/now/now-model.ts`) — not the `confirmed`-only
 * test `resolveNowActivity` (`planning/now-activity.ts` in contracts) holds a *protected* commitment to before it takes
 * over the clock. Those are two different questions: whether a commitment currently owns "now" (strict,
 * `confirmed` only — a merely tentative one should never block other work) versus what commitment is
 * coming up next, which the Now page's own `nextCommitment` — the same "Next commitment: X at Y" line
 * `recommendation-panel.tsx` renders — has always answered with tentative ones included. A previous
 * revision here narrowed this filter to `confirmed` on the mistaken belief that `resolveNowActivity`'s
 * stricter rule was the standard to match, which made the handheld hide a tentative "next" the Now page
 * was still showing on the phone for the same row. Restored to agree with `nextCommitment`.
 */
function resolveNext(state: PortalState, now: Date): DeviceSnapshot["next"] {
  const next = state.commitments
    .filter((item) => item.status !== "cancelled" && new Date(item.startsAt).getTime() > now.getTime())
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0];
  return next ? { title: fitDeviceText(next.title), startsAt: new Date(next.startsAt).getTime() } : null;
}

function computeNextChangeAt(
  activity: DeviceActivity | null,
  next: DeviceSnapshot["next"],
  state: PortalState,
  leaveByLegs: readonly LeaveByLeg[],
  resolution: ActivityResolution,
  now: Date
): number | null {
  const candidates: number[] = [];
  if (activity?.countdown && activity.endsAt !== null) candidates.push(activity.endsAt);
  if (activity?.startsAt !== null && activity?.startsAt !== undefined && activity.startsAt > now.getTime())
    candidates.push(activity.startsAt);
  if (next) candidates.push(next.startsAt);
  if (state.planning?.validUntil) candidates.push(new Date(state.planning.validUntil).getTime());
  // Clock-driven changes the snapshot itself depends on, which the plan's `validUntil` does not
  // necessarily land on. Each is filtered to the future below.
  const clockInstants: number[] = [];
  // `canStart` on a commitment resolution flips when the phase has under 30 s left (rounds to < 1 min).
  if (resolution.kind === "commitment") {
    const phaseEnd =
      resolution.protectedCommitment.phase === "active"
        ? resolution.protectedCommitment.protectedEndAt
        : resolution.protectedCommitment.phaseEndsAt;
    clockInstants.push(phaseEnd.getTime() - 30_000);
  }
  // A pending routine step's window opening, and a planned sleep's window opening.
  for (const step of state.routineSteps)
    if (step.status === "pending" && step.scheduledStartAt)
      clockInstants.push(new Date(step.scheduledStartAt).getTime());
  for (const plan of state.sleepPlans)
    if (plan.status === "planned") clockInstants.push(new Date(plan.plannedStartAt).getTime());
  // An asserted location going stale flips the `arrived` suppression.
  if (state.currentSituation.locationSetAt)
    clockInstants.push(
      new Date(state.currentSituation.locationSetAt).getTime() + DEFAULT_LOCATION_STALE_AFTER_MINUTES * 60_000
    );
  for (const instant of clockInstants)
    if (Number.isFinite(instant) && instant > now.getTime()) candidates.push(instant);
  // `remindAt`, `leaveAt` and `leaveAt + 5 min` (the grace end, which drops the leg) — every instant
  // at which an unsuppressed leg's own phase could change.
  // Filtered to the future: unlike the other candidates above, a leg already past one of these
  // instants is common (an old `remindAt` on a leg now in `leave` phase), and including it would pull
  // `nextChangeAt` backwards into the past.
  for (const leg of leaveByLegs) {
    if (leg.suppressedBy) continue;
    for (const instant of [leg.remindAt.getTime(), leg.leaveBy.getTime(), leg.leaveBy.getTime() + 5 * 60_000])
      if (instant > now.getTime()) candidates.push(instant);
  }
  return candidates.length ? Math.min(...candidates) : null;
}

interface ResolvedDeviceState {
  protectedInfo: ProtectedInfo | undefined;
  resolution: ActivityResolution;
  late: DeviceSnapshot["late"];
  arrival: DeviceSnapshot["arrival"];
}

/**
 * The device's whole reading of state, in one call to the shared precedence chain
 * (`planning/now-activity.ts` in contracts). `protectedInfo` comes back out of it because the device asks about
 * lateness and arrival independently of what won the moment — both are true of a commitment even
 * while a session is running against it.
 */
function resolveDeviceState(state: PortalState, now: Date): ResolvedDeviceState {
  const recommendation = hydrateJson<DeviceRecommendation>(state.planning?.result?.recommendation ?? null);
  const activity = resolveNowActivity<DeviceCandidate, DeviceProtectedCommitment>({
    state,
    now,
    currentDirective: state.planning?.result?.currentDirective ?? null,
    protectedCommitment: recommendation?.protectedCommitment ?? null,
    primary: recommendation?.primary ?? null
    // No `manualBedtime`: bedtime cannot be brought forward from the device, so sleep claims the
    // moment here only once its own window has opened.
  });
  return {
    protectedInfo: activity.protectedInfo,
    resolution: activity.resolution,
    late: buildLate(activity.protectedInfo, now),
    arrival: buildArrival(state, activity.protectedInfo)
  };
}

/**
 * The offer-log `shown` target for what this snapshot's activity stands for, built from the real resolution and the
 * hydrated engine primary (never the trimmed wire `DeviceActivity`), by the same `shownTargetFor` the Now page uses,
 * so the same state logs the same session, travel and suppressedBy keys on both surfaces.
 */
export function deviceShownTarget(state: PortalState, now: Date): ShownTarget {
  const { resolution } = resolveDeviceState(state, now);
  const primary = hydrateJson<DeviceRecommendation>(state.planning?.result?.recommendation ?? null)?.primary ?? null;
  return shownTargetFor(resolution, primary);
}

/**
 * Every eligible leave-by leg for right now, from the same pure rules the worker's scheduler and
 * Now's On my way button read (`leaveByPrompts`). `observationsAwayFromOrigin` always answers false
 * here: unlike the scheduler, this builder does no device-trail query of its own — it is meant to
 * stay pure over `PortalState` alone, like the rest of `buildDeviceSnapshot`. That drops one piece of
 * suppression evidence (a raw device ping away from the origin with no location assertion yet), which
 * only delays hiding an already-departed leg's banner by at most a poll; it never causes a duplicate
 * send, since the outbox scheduler is the one thing that actually decides that with the full trail.
 */
function leaveByLegsNow(state: PortalState, now: Date): LeaveByLeg[] {
  const timelines = state.planning?.result?.derivedState?.commitmentTimelines ?? [];
  if (!timelines.length) return [];
  const commitments: LeaveByCommitment[] = state.commitments.map((commitment) => ({
    id: commitment.id,
    startsAt: commitment.startsAt,
    status: commitment.status,
    title: commitment.title,
    ...(commitment.attendance ? { attendance: commitment.attendance } : {})
  }));
  const locationSetAt = state.currentSituation.locationSetAt ?? null;
  const stale =
    !locationSetAt ||
    (now.getTime() - new Date(locationSetAt).getTime()) / 60_000 > DEFAULT_LOCATION_STALE_AFTER_MINUTES;
  return leaveByPrompts({
    timelines,
    commitments,
    situation: {
      locationId: state.currentSituation.locationId ?? null,
      locationSetAt,
      stale,
      underway: state.currentSituation.underway ?? null
    },
    observationsAwayFromOrigin: () => false,
    leadMinutes: state.settings.leaveByLeadMinutes,
    now
  });
}

/** "Yes, I'm home", the fixed handheld button wording for `at_origin`. */
const ORIGIN_LABEL = "Yes, I'm home";

function buildLeaveByView(
  legs: readonly LeaveByLeg[],
  now: Date,
  canConfirmOrigin = true
): { leaveBy: DeviceLeaveBy | null; wakeAt: number | null } {
  const shown = legs
    .filter(
      (leg): leg is LeaveByLeg & { phase: "remind" | "leave" } =>
        !leg.suppressedBy && (leg.phase === "remind" || leg.phase === "leave")
    )
    .sort((a, b) => a.leaveBy.getTime() - b.leaveBy.getTime())[0];
  const leaveBy: DeviceLeaveBy | null = shown
    ? {
        commitmentId: shown.commitmentId,
        title: fitDeviceText(`Leave for ${shown.title}`),
        leaveAt: shown.leaveBy.getTime(),
        phase: shown.phase,
        assumedOrigin: shown.originAssumed,
        originLabel: shown.originAssumed && canConfirmOrigin ? ORIGIN_LABEL : null
      }
    : null;
  const futureInstants = legs
    .filter((leg) => !leg.suppressedBy)
    .flatMap((leg) => [leg.remindAt.getTime(), leg.leaveBy.getTime()])
    .filter((instant) => instant > now.getTime());
  const wakeAt = futureInstants.length ? Math.min(...futureInstants) : null;
  return { leaveBy, wakeAt };
}

/**
 * Whether the plan the snapshot was read from is still the current one. The same two facts the Now
 * page's status row reads (`now-model.ts`'s `planningDecisionCurrent`), minus the browser-only
 * "a poll has seen a newer run than this tab" part, which has no meaning for a device that holds no
 * plan of its own.
 */
function resolvePlanFresh(state: PortalState, now: Date): boolean {
  return (
    state.planning?.status === "current" &&
    Boolean(state.planning.validUntil && new Date(state.planning.validUntil).getTime() > now.getTime())
  );
}

/**
 * Hashed from every field but `serverTime` and `late.lateByMin` — the two values that would
 * otherwise churn the hash every minute (or every poll) without anything the device cares about
 * having actually changed. First 16 hex characters of a sha1 are plenty for an opaque cache key
 * nothing else parses.
 *
 * `planFresh` is deliberately *not* excluded despite also being time-derived: it changes at most
 * twice a plan, and a device asleep on a `304` would otherwise never learn that the plan behind what
 * it is showing has expired.
 */
function hashCore(core: Omit<DeviceSnapshot, "serverTime" | "stateVersion">): string {
  const hashable = { ...core, late: { isLate: core.late.isLate } };
  return createHash("sha1").update(JSON.stringify(hashable)).digest("hex").slice(0, 16);
}

export function buildDeviceSnapshot(state: PortalState, now: Date, checkIn: DeviceCheckIn): DeviceSnapshot {
  const resolved = resolveDeviceState(state, now);
  const activity = buildActivityView(state, resolved.resolution, now);
  const next = resolveNext(state, now);
  const leaveByLegs = leaveByLegsNow(state, now);
  // "Yes, I'm home" asserts a place; with no current place and no home there is none to assert.
  const canConfirmOrigin = Boolean(state.currentSituation.locationId ?? state.settings.homeLocationId);
  const { leaveBy, wakeAt } = buildLeaveByView(leaveByLegs, now, canConfirmOrigin);
  const core: Omit<DeviceSnapshot, "serverTime" | "stateVersion"> = {
    planFresh: resolvePlanFresh(state, now),
    activity,
    late: resolved.late,
    tracking: buildTrackingView(state),
    arrival: resolved.arrival,
    checkIn,
    next,
    actions: buildActionsView(
      resolved.resolution,
      resolved.arrival,
      leaveBy,
      now,
      leaveBy !== null && onMyWayOrigin(state, leaveBy.commitmentId) !== null
    ),
    nextChangeAt: computeNextChangeAt(activity, next, state, leaveByLegs, resolved.resolution, now),
    leaveBy,
    wakeAt
  };
  return { serverTime: now.getTime(), stateVersion: hashCore(core), ...core };
}

/**
 * What `{"type":"start"}` would do, computed against the exact same precedence `buildDeviceSnapshot`
 * used to describe `activity` — recomputed fresh rather than trusted from a client-held snapshot,
 * since the device's last poll can be seconds stale. `null` means nothing is startable right now;
 * `{ kind: "blocked" }` means something is on the clock but starting it would be meaningless (its
 * window has already passed) — both are 409s to the caller, `blocked` just carries a specific reason.
 *
 * Tagged by which store method the command belongs to rather than left as a bare
 * `ActivityCommand | SessionCommand`: the two contracts share no discriminant that lets a caller
 * narrow between them (`"start"` only rules out one of several `SessionCommand` variants), so the tag
 * carries the distinction structural narrowing cannot.
 *
 * `commandId` is the route's to choose (`resolveDeviceCommandId`), not this module's: the route is
 * what knows whether the device sent one of its own, and it needs the exact value before calling this
 * function at all, to check `writes` for a replay ahead of state-based preconditions like
 * "something startable" that a successful-but-unacknowledged first attempt would have already made
 * false.
 */
export function planStartCommand(
  state: PortalState,
  now: Date,
  commandId: string
):
  | { kind: "activity"; command: ActivityCommand }
  | { kind: "session"; command: SessionCommand }
  | { kind: "blocked"; reason: string }
  | null {
  const { resolution } = resolveDeviceState(state, now);
  switch (resolution.kind) {
    case "commitment": {
      const { commitment, protectedCommitment } = resolution;
      // A commitment run late enough can have its own phase end (which, per the engine, holds at
      // `commitment.endsAt` while it's `late`) already behind `now` — the whole window has elapsed
      // with the prep still undone. Flooring that at `Math.max(1, …)` used to hand back a technically
      // valid but meaningless 1-minute session (report: device Start while late opened a 1-minute
      // commitment session); refusing is the honest answer, matching the other "nothing to act on
      // right now" refusals in this module rather than fabricating a session against a window that's
      // already over.
      const rawMinutes = commitmentPhaseRawMinutes(protectedCommitment, now);
      if (rawMinutes < 1) return { kind: "blocked", reason: "The commitment window has passed." };
      return {
        kind: "activity",
        command: {
          commandId,
          expectedVersion: commitment.version ?? null,
          type: "start_activity",
          targetType: "fixed_commitment",
          targetId: commitment.id,
          plannedMinutes: rawMinutes,
          ...(protectedCommitment.phase ? { phase: protectedCommitment.phase } : {})
        }
      };
    }
    case "routine_step": {
      const { step } = resolution;
      return {
        kind: "activity",
        command: {
          commandId,
          expectedVersion: step.version ?? null,
          type: "start_activity",
          targetType: "routine_step",
          targetId: step.id,
          plannedMinutes: step.durationMinutes
        }
      };
    }
    case "recommended": {
      const { candidate } = resolution;
      return {
        kind: "session",
        command: {
          commandId,
          expectedVersion: null,
          type: "start",
          actionId: candidate.action.id,
          plannedMinutes: candidate.recommendedMinutes ?? 25,
          recommendationId: state.currentRecommendationId ?? null
        }
      };
    }
    default:
      return null;
  }
}

/**
 * What `{"type":"arrived"}` would do: the exact `save_entity` shape `situationCommand`
 * (`components/situation-panel.tsx`) builds, so an accepted device tap is indistinguishable from the
 * browser's own arrival button. `null` when nothing is pending — the caller answers 409. `commandId`
 * is the route's resolved id, for the same reason `planStartCommand` takes one.
 */
export function planArriveCommand(state: PortalState, now: Date, commandId: string): PlanningEntityCommand | null {
  const { protectedInfo, arrival } = resolveDeviceState(state, now);
  if (!protectedInfo || !arrival.pending) return null;
  return {
    commandId,
    expectedVersion: state.settings.version ?? null,
    type: "save_entity",
    entityType: "current_availability",
    entity: {
      currentEnergy: state.currentEnergy,
      assertedConditions: state.assertedConditions,
      currentSituation: { locationId: protectedInfo.commitment.locationId }
    }
  };
}

/**
 * The origin `leaveByLegsNow`'s underlying timeline entry names for `commitmentId` — not carried on
 * `LeaveByLeg` itself, which only exposes what the phase/suppression rules need. Looked up again here
 * because `on_my_way` is the one place that needs it: the place On my way is departing *from*.
 */
function leaveByOriginLocationId(state: PortalState, commitmentId: string): string | undefined {
  const timelines = state.planning?.result?.derivedState?.commitmentTimelines ?? [];
  return timelines.find((timeline) => timeline.id === commitmentId)?.journeyBefore?.fromLocationId;
}

/** The place On my way departs from: the leg's origin, else the current place. An unknown origin ("") is none. */
function onMyWayOrigin(state: PortalState, commitmentId: string): string | null {
  return leaveByOriginLocationId(state, commitmentId) || state.currentSituation.locationId || null;
}

/**
 * What `{"type":"on_my_way"}` would do: the same
 * `current_availability` write the Now travel panel's own On my way button makes, against whichever
 * leg `buildLeaveByView` is currently showing. `null` when there is no leg to show, or its origin is
 * still assumed — the caller answers 409 either way, `at_origin` being the device's action for the
 * assumed case.
 */
export function planOnMyWayCommand(state: PortalState, now: Date, commandId: string): PlanningEntityCommand | null {
  const legs = leaveByLegsNow(state, now);
  const { leaveBy } = buildLeaveByView(legs, now);
  if (!leaveBy || leaveBy.assumedOrigin) return null;
  const fromLocationId = onMyWayOrigin(state, leaveBy.commitmentId);
  const occurrenceStartsAt = legs.find((leg) => leg.commitmentId === leaveBy.commitmentId)?.occurrenceStartsAt;
  if (!fromLocationId || !occurrenceStartsAt) return null;
  return {
    commandId,
    expectedVersion: state.settings.version ?? null,
    type: "save_entity",
    entityType: "current_availability",
    entity: {
      currentEnergy: state.currentEnergy,
      assertedConditions: state.assertedConditions,
      currentSituation: {
        underway: {
          commitmentId: leaveBy.commitmentId,
          occurrenceStartsAt,
          fromLocationId,
          departedAt: now.toISOString()
        }
      }
    }
  };
}

/**
 * What `{"type":"at_origin"}` would do: the device's copy of Now's "Yes, I'm here" — asserts the
 * assumed origin place the same way the travel panel's own button does (`situation.locationId ??
 * homeLocationId`), never a place the device itself reports. `null` when there is no leg to show, its
 * origin is already confirmed, or no place can be resolved at all — the caller answers 409.
 */
export function planAtOriginCommand(state: PortalState, now: Date, commandId: string): PlanningEntityCommand | null {
  const legs = leaveByLegsNow(state, now);
  const { leaveBy } = buildLeaveByView(legs, now);
  if (!leaveBy || !leaveBy.assumedOrigin) return null;
  const assumedLocationId = state.currentSituation.locationId ?? state.settings.homeLocationId ?? null;
  if (!assumedLocationId) return null;
  return {
    commandId,
    expectedVersion: state.settings.version ?? null,
    type: "save_entity",
    entityType: "current_availability",
    entity: {
      currentEnergy: state.currentEnergy,
      assertedConditions: state.assertedConditions,
      currentSituation: { locationId: assumedLocationId }
    }
  };
}

/**
 * The namespace `stableUuid` folds a device-supplied `commandId` into, so it can never collide with a
 * uuid some other caller minted for an unrelated purpose from the same raw string. Not `userId`-scoped
 * — the portal is single-tenant/no-auth, so there is exactly one
 * user, and `device-now.ts` has no database access of its own to look one up with anyway.
 */
const DEVICE_COMMAND_NAMESPACE = "device-action";

/**
 * The command id a device action's write should use. When the device sent its own `commandId` (present
 * on firmware built after the 60-second-heuristic removal — see the handheld firmware's network code), the exact
 * same tap retried after a lost response — a POST that timed out after the server had already applied
 * it, or a reply dropped mid-flight — mints the identical string here every time, so the route's own
 * `writes` check (`hasCommandReceipt`) recognises the retry as the same command rather than a
 * new one, ahead of any state-based precondition a successful-but-unacknowledged write would have
 * already made false.
 *
 * `writes.id` is a Postgres `uuid` column, and the wire format the route accepts is looser
 * (`^[A-Za-z0-9-]{8,64}$`, matching a canonical uuid string but not requiring one) so a non-uuid client
 * id — a test harness, or a future firmware that mints ids some other way — still has to land somewhere
 * writable. `stableUuid` is the fold every other user-facing id in this store already goes through for
 * exactly that reason: a uuid-shaped input passes through unchanged, anything else is hashed into one
 * deterministically. No device action issues more than one write today, so there is no id to suffix; a
 * future one that did would derive `${commandId}-1`, `${commandId}-2` the same way `entity-commands.ts`
 * derives sub-ids elsewhere — `stableUuid` folds a string of any length, so there is no budget to mind.
 *
 * Absent (older firmware, which never sends `commandId`), a fresh id is minted per call — the pre-fix
 * behaviour, unchanged for a device that has not been reflashed.
 */
export async function resolveDeviceCommandId(clientCommandId: string | undefined): Promise<string> {
  if (!clientCommandId) return crypto.randomUUID();
  return stableUuid(DEVICE_COMMAND_NAMESPACE, clientCommandId);
}
