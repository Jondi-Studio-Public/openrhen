import type { PortalStateContract } from "../portal/state-schema.js";
import {
  ACTIVITY_STALE_GRACE_HOURS,
  DEFAULT_LOCATION_STALE_AFTER_MINUTES,
  EFFORT_STALE_DAYS,
  ENERGY_STALE_HOURS,
  PAUSED_SESSION_STALE_HOURS,
  SESSION_STALE_MIN_GRACE_MINUTES,
  WAKE_STALE_GRACE_HOURS
} from "./context-constants.js";

/**
 * How old each daily fact the plan reads is, and whether it is still good.
 *
 * The one rule behind "a stale fact is unknown": each observation carries the time it was made and a
 * lifetime, and a consumer treats an expired one as unknown rather than current. Location was the first
 * fact to work this way (`resolveSituation`, which still owns its own nulling); this module is the same
 * idea for the rest, called by the engine, Now, `status` and the server so the rule cannot drift between
 * them. Pure and environment-free: it reads the wire state and a clock, nothing else.
 *
 * `staleAt` is the first instant the fact is stale: at `staleAt` itself it is already unknown, the way a
 * commitment is in force from its start. It is what plan validity ends at, so a plan is recalculated the
 * moment a fact ages out rather than at the next hourly ceiling, and a plan calculated at that instant
 * already reads the fact as unknown.
 */

type ActiveSession = NonNullable<PortalStateContract["activeSession"]>;

/** The slice of portal state the rule reads. `PortalStateContract` and the engine's wire state satisfy it. */
export interface FreshnessState {
  settings: { maxAwakeHours: number; lastWokeAt?: string | undefined };
  activeSession: ActiveSession | null;
  currentSituation: {
    locationId: string | null;
    locationSetAt?: string | undefined;
    energySetAt?: string | undefined;
  };
  /** Read only for effort age, and only with a project health to judge "at risk" by. */
  actions?: ReadonlyArray<EffortAction> | undefined;
}

/** The slice of an action the effort rule reads. */
export interface EffortAction {
  id: string;
  projectId: string;
  title: string;
  status: string;
  remainingMinutes: number;
  /** When `remainingMinutes` was last set or confirmed; absent when that was never recorded. */
  remainingSetAt?: string | undefined;
  schedulingMode?: string | undefined;
}

/**
 * A project's forecast health, as the stored plan reports it, keyed by project id. The effort rule only
 * ages an estimate on a project whose forecast is not comfortable (`atRiskHealth`), so it needs this.
 */
export type ProjectHealthById = ReadonlyMap<string, string>;

/** One open action whose remaining-effort estimate is being aged, on a project the forecast calls at risk. */
export interface EffortFreshness extends FactFreshness {
  asOf: string;
  staleAt: string;
  actionId: string;
  projectId: string;
  title: string;
  remainingMinutes: number;
  /** The project's forecast health: `behind` ranks above `at_risk`. */
  health: "behind" | "at_risk";
}

export interface FactFreshness {
  /** When OpenRhen was last told. Absent when it never was, or when the fact has no single time. */
  asOf?: string;
  stale: boolean;
  /** When the fact goes (or went) stale. Absent when there is nothing to age out. */
  staleAt?: string;
}

export interface Freshness {
  /** The last wake (`settings.lastWokeAt`). Never told is not stale: there is nothing old to distrust. */
  wake: FactFreshness;
  /** The open session. `asOf` is its planned end, or for a paused one when it was paused. */
  session: FactFreshness;
  /** `currentEnergy`, dated by `currentSituation.energySetAt`. Never dated reads as stale. */
  energy: FactFreshness;
  /** The asserted place, with the same rule `resolveSituation` applies. */
  location: FactFreshness;
  /**
   * Remaining effort, per action rather than per day, so a list (the fact freshness design note, "Remaining
   * effort"). Empty unless `resolveFreshness` was given a project health; then every open one-off action of
   * an at-risk project that carries a `remainingSetAt`, behind projects first and the oldest estimate first
   * within each. Effort never becomes unknown to the engine, so there is no `staleAt` to end a plan at.
   */
  effort: EffortFreshness[];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Sessions against these are routines and commitments, not work: they age on a longer clock. */
const ACTIVITY_TARGETS: ReadonlySet<string> = new Set(["routine_step", "routine_instance", "fixed_commitment"]);

function parse(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

function fact(asOfMs: number, staleAtMs: number, nowMs: number): FactFreshness {
  return {
    asOf: new Date(asOfMs).toISOString(),
    stale: nowMs >= staleAtMs,
    staleAt: new Date(staleAtMs).toISOString()
  };
}

function wakeFreshness(state: FreshnessState, nowMs: number): FactFreshness {
  const wokeMs = parse(state.settings.lastWokeAt);
  if (wokeMs === undefined) return { stale: false };
  // No one stays up past their own awake limit and then some: an older wake means a night went by
  // unrecorded. His own limit rather than a clock time keeps a shift day right.
  const staleAtMs = wokeMs + state.settings.maxAwakeHours * HOUR + WAKE_STALE_GRACE_HOURS * HOUR;
  return fact(wokeMs, staleAtMs, nowMs);
}

/**
 * A session whose end is already its pause: paused, or paused and then moved to awaiting feedback
 * (`request_feedback` keeps `paused_remaining_seconds`). The server refuses such a session an end after the
 * pause (`resolveRetroactiveEnd`), so it is aged from the pause and finished as it stands, with no time asked.
 */
export function endsAtPause(session: ActiveSession): boolean {
  return session.status === "paused" || (session.status === "feedback" && session.pausedRemainingSeconds !== undefined);
}

function sessionFreshness(session: ActiveSession | null, nowMs: number): FactFreshness {
  if (!session) return { stale: false };
  const targetType = session.targetType ?? "action";
  // Being asleep is not a forgotten session; a missing wake is judged on its own.
  if (targetType === "sleep") return { stale: false };
  const plannedEndMs = parse(session.plannedEndAt);
  if (plannedEndMs === undefined) return { stale: false };
  const activity = ACTIVITY_TARGETS.has(targetType);
  if (!activity && endsAtPause(session)) {
    // A paused session has no end to run past; it ages from the pause. A result stored before the
    // pause was dated falls back to the planned end.
    const pausedMs = parse(session.pausedAt) ?? plannedEndMs;
    const staleAtMs = pausedMs + PAUSED_SESSION_STALE_HOURS * HOUR;
    return fact(pausedMs, staleAtMs, nowMs);
  }
  const graceMs = activity
    ? ACTIVITY_STALE_GRACE_HOURS * HOUR
    : Math.max(SESSION_STALE_MIN_GRACE_MINUTES, session.plannedMinutes) * MINUTE;
  const staleAtMs = plannedEndMs + graceMs;
  return fact(plannedEndMs, staleAtMs, nowMs);
}

function energyFreshness(state: FreshnessState, nowMs: number): FactFreshness {
  const setMs = parse(state.currentSituation.energySetAt);
  // Never dated: nothing says when this was true, so it is not trusted. No `staleAt`, as there is no
  // time to count from.
  if (setMs === undefined) return { stale: true };
  const wokeMs = parse(state.settings.lastWokeAt);
  // Said before the last wake, it describes a person who has since slept.
  if (wokeMs !== undefined && setMs < wokeMs) return { ...fact(setMs, wokeMs, nowMs), stale: true };
  return fact(setMs, setMs + ENERGY_STALE_HOURS * HOUR, nowMs);
}

function locationFreshness(state: FreshnessState, nowMs: number): FactFreshness {
  const { locationId, locationSetAt } = state.currentSituation;
  const setMs = parse(locationSetAt);
  // Mirrors `resolveSituation`: only an asserted place with a date can age; the rest is already unknown.
  if (locationId === null || setMs === undefined) return { stale: false };
  // `resolveSituation` keeps a place up to and including its limit (and the schedulers that skip steps
  // and check-ins by it say the same), so it is first unknown a millisecond after.
  return fact(setMs, setMs + DEFAULT_LOCATION_STALE_AFTER_MINUTES * MINUTE + 1, nowMs);
}

/** Actions that still have work in them and are priced into the forecast (`inbox` included, as the engine does). */
const EFFORT_OPEN_STATUSES: ReadonlySet<string> = new Set(["inbox", "planned", "active", "doing"]);

/**
 * "At risk" for the effort rule: the stored forecast says the project is `behind` or `at_risk`, the pair the
 * engine already treats as one (`schedule.ts` interventions, `engine.ts` pace). `on_track`, `ahead` and `unknown`
 * leave an old estimate alone: it is not what the plan turns on.
 */
export function atRiskHealth(health: string | undefined): health is "behind" | "at_risk" {
  return health === "behind" || health === "at_risk";
}

/**
 * Whether one remaining-effort estimate is aged: set 14 days ago or more. Absent or unreadable is not aged:
 * nothing says when it was set, and a stored request from before the column must not flag every action.
 * Shared with the forecast so both read it the same way.
 */
export function effortAge(
  remainingSetAt: string | Date | undefined,
  now: Date
): (FactFreshness & { asOf: string; staleAt: string }) | undefined {
  const setMs = remainingSetAt === undefined ? undefined : new Date(remainingSetAt).getTime();
  if (setMs === undefined || Number.isNaN(setMs)) return undefined;
  const staleAtMs = setMs + EFFORT_STALE_DAYS * 24 * HOUR;
  const { asOf, staleAt, stale } = fact(setMs, staleAtMs, now.getTime());
  return { asOf: asOf!, staleAt: staleAt!, stale };
}

function effortFreshness(
  actions: ReadonlyArray<EffortAction> | undefined,
  projectHealth: ProjectHealthById | undefined,
  agedActionIds: ReadonlySet<string> | undefined,
  now: Date
): EffortFreshness[] {
  if (!actions || !projectHealth) return [];
  const list: EffortFreshness[] = [];
  for (const action of actions) {
    // Given the plan's own aged inputs, only those: an action the forecast left out (held back behind a blocked
    // prerequisite) lowered no confidence, so it is not asked about either.
    if (agedActionIds && !agedActionIds.has(action.id)) continue;
    const health = projectHealth.get(action.projectId);
    // A cadence or recurring action's remaining effort is reset by its cycle, and the forecast does not price it.
    if (!atRiskHealth(health) || (action.schedulingMode ?? "one_off") !== "one_off") continue;
    if (!EFFORT_OPEN_STATUSES.has(action.status) || action.remainingMinutes <= 0) continue;
    const age = effortAge(action.remainingSetAt, now);
    if (!age) continue;
    list.push({
      actionId: action.id,
      projectId: action.projectId,
      title: action.title,
      remainingMinutes: action.remainingMinutes,
      health,
      ...age
    });
  }
  return list.sort(
    (a, b) =>
      Number(b.health === "behind") - Number(a.health === "behind") ||
      a.asOf.localeCompare(b.asOf) ||
      a.actionId.localeCompare(b.actionId)
  );
}

/**
 * Reads a project's forecast health out of the stored plan's `schedule`, which travels as opaque JSON:
 * `forecasts: [{ projectId, health }]`. Anything that does not look like that reads as no health at all, so a
 * missing or older plan flags nothing.
 */
export function projectHealthFromSchedule(schedule: unknown): ProjectHealthById {
  const forecasts = (schedule as { forecasts?: unknown } | null | undefined)?.forecasts;
  const health = new Map<string, string>();
  if (!Array.isArray(forecasts)) return health;
  for (const forecast of forecasts) {
    const { projectId, health: value } = (forecast ?? {}) as { projectId?: unknown; health?: unknown };
    if (typeof projectId === "string" && typeof value === "string") health.set(projectId, value);
  }
  return health;
}

/**
 * The actions the stored plan's forecasts list as aged inputs (`forecasts: [{ agedInputs: [{ actionId }] }]`), the
 * ones whose old estimate lowered a project's confidence. A plan from before effort age lists none.
 */
export function agedInputIdsFromSchedule(schedule: unknown): ReadonlySet<string> {
  const forecasts = (schedule as { forecasts?: unknown } | null | undefined)?.forecasts;
  const aged = new Set<string>();
  if (!Array.isArray(forecasts)) return aged;
  for (const forecast of forecasts) {
    const inputs = (forecast as { agedInputs?: unknown } | null | undefined)?.agedInputs;
    if (!Array.isArray(inputs)) continue;
    for (const input of inputs) {
      const actionId = (input as { actionId?: unknown } | null | undefined)?.actionId;
      if (typeof actionId === "string") aged.add(actionId);
    }
  }
  return aged;
}

/**
 * `projectHealth` is optional because only a reader of a calculated plan has one: the engine calls this
 * before its forecast exists (it ages effort inside the forecast, where each project's health is known).
 * `agedActionIds`, from the same plan, narrows effort to the estimates that forecast aged, so Now asks about exactly
 * what lowered its confidence; the state's own date still has to be stale, so an answer clears the question at once.
 */
export function resolveFreshness(
  state: FreshnessState,
  now: Date,
  options: { projectHealth?: ProjectHealthById; agedActionIds?: ReadonlySet<string> } = {}
): Freshness {
  const nowMs = now.getTime();
  return {
    wake: wakeFreshness(state, nowMs),
    session: sessionFreshness(state.activeSession, nowMs),
    energy: energyFreshness(state, nowMs),
    location: locationFreshness(state, nowMs),
    effort: effortFreshness(state.actions, options.projectHealth, options.agedActionIds, now)
  };
}

/**
 * The soonest moment a still-good fact goes stale, so a plan can end its validity there. Facts that
 * are stale already, or have no age to run out, contribute nothing. Effort is left out on purpose: it
 * ages only inside the forecast's confidence line (never the ranking), a plan is valid for an hour at
 * most, and each action's 14 days would otherwise cut that short on a date nobody is waiting for.
 */
export function nextStaleAt(freshness: Freshness, now: Date): Date | undefined {
  const upcoming = [freshness.wake, freshness.session, freshness.energy, freshness.location]
    .filter((item) => !item.stale && item.staleAt !== undefined)
    .map((item) => new Date(item.staleAt!))
    .filter((date) => date > now);
  return upcoming.length ? new Date(Math.min(...upcoming.map((date) => date.getTime()))) : undefined;
}

/** A length of time as a person says it: "45 min", "1.5 h", "19 h", "21 days". */
export function spanLabel(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE));
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  if (hours < 10) return `${Number(hours.toFixed(1))} h`;
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} days`;
}

/** What to call the open session: its own title, else the action it is against, else a plain name. */
export function openSessionTitle(
  session: ActiveSession,
  actions: ReadonlyArray<{ id: string; title: string }> = []
): string {
  return (
    session.targetTitle ??
    actions.find((action) => action.id === (session.targetId || session.actionId))?.title ??
    "Open session"
  );
}

/** The question a stale wake puts to the person, in the same words on every surface. */
export function wakeQuestion(lastWokeAt: string, now: Date): string {
  return `Last woke ${spanLabel(now.getTime() - new Date(lastWokeAt).getTime())} ago. When did you wake up?`;
}

/** The question a stale open session puts to the person, in the same words on every surface. */
export function sessionEndQuestion(session: ActiveSession, now: Date): string {
  // A paused session stopped at its pause, already recorded: what is left to say is whether it is over.
  if (endsAtPause(session)) {
    const since = parse(session.pausedAt) ?? parse(session.plannedEndAt) ?? now.getTime();
    return `Paused ${spanLabel(now.getTime() - since)} ago. Finish it?`;
  }
  if (session.status === "feedback")
    return `Waiting for your feedback since its planned end, ${spanLabel(now.getTime() - (parse(session.plannedEndAt) ?? now.getTime()))} ago. When did it stop?`;
  const startedMs = parse(session.startedAt) ?? now.getTime();
  return `Running ${spanLabel(now.getTime() - startedMs)}, planned ${spanLabel(session.plannedMinutes * MINUTE)}. When did it stop?`;
}
