import { createHash } from "node:crypto";
import {
  buildDay,
  buildNowAnswer,
  CLIENT_VIEW_PARTS,
  CLIENT_VIEW_SCHEMA_VERSION,
  type ClientPending,
  type ClientView,
  type ClientViewPart
} from "@openrhen/contracts";
import { leaveByLegsNow } from "@/server/device/device-now";
import type { StoredCheckIn } from "@/server/persistence/postgres/readers/check-in-read";
import type { PortalState } from "@/state/portal-state";

/**
 * The client view (`GET /api/client/view`): the Now answer, the day and what is waiting, for an installed app and
 * its widgets. It is built from the same functions the web and `rhen status` use (`buildNowAnswer`, `buildDay`,
 * `leaveByPrompts` through `leaveByLegsNow`), so a client never re-derives what the engine decided. It is a pure
 * function of the state, the clock and the waiting check-in; the route owns the reads.
 */

/** Parses `?parts=`: a comma list of known parts, all three when absent. An unknown or empty part is an error. */
export function parseClientViewParts(
  raw: string | null
): { ok: true; parts: ClientViewPart[] } | { ok: false; error: string } {
  if (raw === null) return { ok: true, parts: [...CLIENT_VIEW_PARTS] };
  const asked = raw.split(",").map((part) => part.trim());
  const unknown = asked.filter((part) => !(CLIENT_VIEW_PARTS as readonly string[]).includes(part));
  if (unknown.length > 0 || asked.length === 0)
    return {
      ok: false,
      error: `Unknown part ${JSON.stringify(unknown[0] ?? raw)}. parts is a comma list of ${CLIENT_VIEW_PARTS.join(", ")}.`
    };
  return { ok: true, parts: CLIENT_VIEW_PARTS.filter((part) => asked.includes(part)) };
}

function planCurrent(state: PortalState, now: Date): boolean {
  const planning = state.planning;
  return (
    planning?.status === "current" &&
    Boolean(planning.validUntil) &&
    new Date(planning.validUntil as string).getTime() > now.getTime()
  );
}

function buildNow(state: PortalState, now: Date, current: boolean): NonNullable<ClientView["now"]> {
  const planning = state.planning;
  const locationNameById = new Map(state.conditionDefinitions.map((context) => [context.id, context.name]));
  const answer = buildNowAnswer(
    {
      state,
      currentDirective: planning?.result?.currentDirective,
      dayPlan: planning?.result?.dayPlan,
      recommendation: planning?.result?.recommendation,
      schedule: planning?.result?.schedule,
      planCalculatedAt: planning?.lastSuccessfulAt,
      planCurrent: current,
      now
    },
    locationNameById
  ) as NonNullable<ClientView["now"]>;
  const expectedVersion = startVersion(state, answer.directive);
  return expectedVersion === undefined ? answer : { ...answer, directive: { ...answer.directive!, expectedVersion } };
}

/**
 * The version the `start` command checks for an action directive: the action's own, or the series template's when the
 * directive names one of its occurrences (the same lookup the web's Start does). Absent for every other kind and for
 * a target the state does not hold, so a client then re-reads rather than guessing.
 */
function startVersion(state: PortalState, directive: { kind: string; targetId?: string | undefined } | null) {
  if (directive?.kind !== "action" || directive.targetId === undefined) return undefined;
  const occurrence = state.occurrences.find((item) => item.id === directive.targetId);
  return state.actions.find((action) => action.id === (occurrence?.actionId ?? directive.targetId))?.version;
}

function buildSession(state: PortalState, now: Date): ClientPending["session"] {
  const session = state.activeSession;
  if (!session) return null;
  // The portal stamps `targetTitle` only on non-action sessions; an action session is named by its action.
  const actionTitle =
    session.targetTitle === undefined && (session.targetType === undefined || session.targetType === "action")
      ? state.actions.find((action) => action.id === (session.targetId ?? session.actionId))?.title
      : undefined;
  // A paused session's clock is stopped: what is left is what the pause froze, not the distance to a planned end.
  const minutesLeft =
    session.status === "paused" && session.pausedRemainingSeconds !== undefined
      ? Math.round(session.pausedRemainingSeconds / 60)
      : Math.round((new Date(session.plannedEndAt).getTime() - now.getTime()) / 60_000);
  return {
    id: session.id,
    ...(session.version !== undefined ? { version: session.version } : {}),
    status: session.status,
    title: session.targetTitle ?? actionTitle ?? session.actionId,
    ...(session.targetType !== undefined ? { targetType: session.targetType } : {}),
    ...(session.targetId !== undefined ? { targetId: session.targetId } : {}),
    startedAt: session.startedAt,
    plannedEndAt: session.plannedEndAt,
    plannedMinutes: session.plannedMinutes,
    elapsedMinutes: Math.round(session.activeElapsedSeconds / 60),
    minutesLeft
  };
}

/** The same leg the handheld shows: the earliest unsuppressed one in its `remind` or `leave` phase. */
function buildLeaveBy(state: PortalState, now: Date): ClientPending["leaveBy"] {
  const leg = leaveByLegsNow(state, now)
    .filter((candidate) => !candidate.suppressedBy && (candidate.phase === "remind" || candidate.phase === "leave"))
    .sort((a, b) => a.leaveBy.getTime() - b.leaveBy.getTime())[0];
  if (!leg) return null;
  return {
    commitmentId: leg.commitmentId,
    occurrenceStartsAt: leg.occurrenceStartsAt,
    title: leg.title,
    leaveBy: leg.leaveBy.toISOString(),
    remindAt: leg.remindAt.toISOString(),
    phase: leg.phase as "remind" | "leave",
    typicalMinutes: leg.typicalMinutes,
    allowingMinutes: leg.allowingMinutes,
    originAssumed: leg.originAssumed
  };
}

function buildCheckIn(checkIn: StoredCheckIn | null): ClientPending["checkIn"] {
  if (!checkIn || (checkIn.status !== "pending" && checkIn.status !== "unknown")) return null;
  return {
    id: checkIn.id,
    version: checkIn.version,
    slotAt: checkIn.slotAt,
    promptedAt: checkIn.promptedAt,
    directiveKind: checkIn.directiveKind,
    directiveTargetId: checkIn.directiveTargetId,
    directivePhase: checkIn.directivePhase,
    directiveTitle: checkIn.directiveTitle,
    status: checkIn.status
  };
}

/** `checkIn` is read by the route with `stamp: false`, so building a view never starts the check-in's timeout. */
export function buildClientView(
  state: PortalState,
  now: Date,
  parts: readonly ClientViewPart[],
  checkIn: StoredCheckIn | null
): ClientView {
  const current = planCurrent(state, now);
  return {
    schemaVersion: CLIENT_VIEW_SCHEMA_VERSION,
    timezone: state.settings.timezone ?? "UTC",
    planCurrent: current,
    validUntil: state.planning?.validUntil ?? null,
    ...(parts.includes("now") ? { now: buildNow(state, now, current) } : {}),
    ...(parts.includes("day") ? { day: buildDay({ state, result: state.planning?.result, now }) } : {}),
    ...(parts.includes("pending")
      ? {
          pending: {
            checkIn: buildCheckIn(checkIn),
            session: buildSession(state, now),
            leaveBy: buildLeaveBy(state, now),
            placeSuggestion: state.pendingLocationSuggestion ?? null
          }
        }
      : {})
  };
}

/** A strong validator over the serialised body: any change to any part, however small, is a new tag. */
export function clientViewETag(body: string): string {
  return `"${createHash("sha1").update(body).digest("base64url")}"`;
}

/** Whether `If-None-Match` names the tag: quotes and a `W/` prefix are ignored, a list and `*` are accepted. */
export function clientViewETagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  const wanted = etag.replace(/^"|"$/g, "");
  return header
    .split(",")
    .map((entry) => entry.trim())
    .some((entry) => entry === "*" || entry.replace(/^W\//i, "").replace(/^"|"$/g, "") === wanted);
}
