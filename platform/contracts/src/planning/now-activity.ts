import type { CurrentDirective } from "./plan-forecast.js";
import type { PortalStateContract } from "../portal/state-schema.js";
import { evaluateConditions, resolveSituation, type ResolvedSituation } from "../readiness.js";
import { resolvePulse, type Pulse, type PulseSessionTargetType } from "./pulse.js";

type ActiveSession = NonNullable<PortalStateContract["activeSession"]>;
type StoredCommitment = PortalStateContract["commitments"][number];
type StoredRoutineStep = PortalStateContract["routineSteps"][number];
type StoredSleepPlan = PortalStateContract["sleepPlans"][number];

/**
 * What is on the clock right now, decided once for every surface that asks.
 *
 * The Now page (`features/now/now-model.ts`) and the handheld device (`server/device/device-now.ts`)
 * ask the same question of the same stored plan and used to answer it with two implementations. The
 * device's copy carried "Mirrors now-model.ts's…" comments and drifted anyway — it missed the
 * running-late branch entirely, and mirroring the fix back only restored the coincidence rather than
 * removing the second opinion. This module is the one opinion: pure, environment-free (no React, no
 * `"use client"`, no node built-ins, no database), taking plain state slices and returning a
 * discriminated resolution plus the derived pieces each consumer maps onto its own view model.
 *
 * Nothing here re-decides anything the engine already decided. `scheduledStartAt`, `currentDirective`,
 * `protectedCommitment.late` and the recommendation itself are read as verdicts. What this module
 * owns is the reading: which of those verdicts is still admissible (a commitment must still be a
 * confirmed row), and the fallbacks the engine leaves to the surface (an in-window step when the
 * directive names none, the overdue-prerequisite redirect, arrival mootness, sleep dueness).
 *
 * The resolution's order is the precedence contract the device's `GET /api/device/now` documents
 *. The Now page still orders its own *panels* in `app/page.tsx`,
 * and two of its choices differ from this order: it draws a protected commitment ahead of a routine
 * step even while that commitment is `late`, and a due sleep ahead of a routine step. So the page
 * consumes the derived pieces below rather than `resolution`, which `buildNowModel` carries through
 * as `NowModel.activity` for when those two orders are reconciled. The derivations — which is where
 * the drift actually happened — are shared either way.
 */

/** The slice of portal state this resolution reads. `PortalStateContract` satisfies it structurally. */
export interface NowActivityState {
  activeSession: ActiveSession | null;
  commitments: StoredCommitment[];
  routineSteps: StoredRoutineStep[];
  sleepPlans: StoredSleepPlan[];
  conditionDefinitions: PortalStateContract["conditionDefinitions"];
  currentSituation: PortalStateContract["currentSituation"];
}

/**
 * The least a protected commitment must carry to take part. Both the browser's
 * `ClientProtectedCommitment` and the device's own hydrated copy satisfy it, and each gets its own
 * richer type back out through the generic rather than being flattened to this.
 */
export interface NowActivityProtectedLike {
  id: string;
  late?: boolean;
}

/** The least a recommendation candidate must carry; both consumers' candidate types satisfy it. */
export interface NowActivityCandidateLike {
  action: { id: string; title: string };
}

export type NowTravelDirective = Extract<CurrentDirective, { kind: "travel" }>;

/** The engine's protected commitment together with the confirmed row that admitted it. */
export interface NowProtectedInfo<TProtected extends NowActivityProtectedLike> {
  commitment: StoredCommitment;
  protectedCommitment: TProtected;
}

/**
 * What is on the clock, in precedence order:
 *
 * 1. `session` — an activity is already running or paused; nothing else is being asked.
 * 2. `travel` — a directed journey comes first whatever else is true, including a commitment it is
 *    the leg to, because there is nothing to start against the leg and naming the commitment instead
 *    would say "sit through it" while you are meant to be driving there (`app/page.tsx` orders its
 *    panels the same way). A travel directive and a routine-step directive are two readings of the
 *    same `currentDirective` and never co-occur, so this only ever outranks the *fallback* step.
 * 3. `routine_step` — the step the engine named, or the one this module found in window. It outranks
 *    its own commitment only while that commitment is `late`, which is precisely when the commitment
 *    is not ready to be sat through because its own preparation is what is overdue.
 * 4. `commitment` — the protected commitment holds the clock.
 * 5. `sleep` — the night's own window has opened.
 * 6. `recommended` — the engine's primary suggestion.
 * 7. `free` — nothing.
 *
 * `source` on a routine step says whether the engine named it (`directive`), the surface found it in
 * window because the engine named something else (`fallback`), or the fallback was redirected to the
 * overdue prerequisite that actually gates the start (`prerequisite`). Consumers do not branch on it;
 * it exists so a report can say which rule produced the step.
 */
export type NowActivityResolution<
  TCandidate extends NowActivityCandidateLike,
  TProtected extends NowActivityProtectedLike
> =
  | { kind: "session"; session: ActiveSession }
  | { kind: "routine_step"; step: StoredRoutineStep; source: "directive" | "fallback" | "prerequisite" }
  | ({ kind: "commitment" } & NowProtectedInfo<TProtected>)
  | { kind: "travel"; directive: NowTravelDirective }
  | { kind: "sleep"; plan: StoredSleepPlan }
  | { kind: "recommended"; candidate: TCandidate }
  | { kind: "free" };

export interface NowActivityInput<
  TCandidate extends NowActivityCandidateLike,
  TProtected extends NowActivityProtectedLike
> {
  state: NowActivityState;
  now: Date;
  /** The engine's directive, exactly as stored. */
  currentDirective: CurrentDirective | null;
  /** The engine's protected commitment, before the confirmed-row test this module applies. */
  protectedCommitment: TProtected | null | undefined;
  /** The engine's primary recommendation, before the precedence chain reaches it. */
  primary: TCandidate | null | undefined;
  /** True while an early bedtime has been chosen by hand. The device has no way to set it. */
  manualBedtime?: boolean;
}

export interface NowActivityBrain<
  TCandidate extends NowActivityCandidateLike,
  TProtected extends NowActivityProtectedLike
> {
  /** The engine's verdict, admitted only while the commitment it names is still a confirmed row. */
  protectedInfo: NowProtectedInfo<TProtected> | undefined;
  /** The situation the context matcher resolved, including whether the location assertion is stale. */
  situation: ResolvedSituation;
  /** True while a late commitment leaves its own before-phase steps directable. */
  routineStepsRunDespiteCommitment: boolean;
  /** The step the surface should offer, from the directive or the in-window fallback. */
  routineDue: StoredRoutineStep | undefined;
  /** Which rule produced `routineDue`; undefined when there is none. */
  routineDueSource: "directive" | "fallback" | "prerequisite" | undefined;
  /** The next planned sleep worth showing at all — suppressed entirely by a protected commitment. */
  upcomingSleep: StoredSleepPlan | undefined;
  /** The next unfinished step of tonight's bedtime routine (a `routine_steps` row now, not a
   *  bundled instance), sorted by sequence — undefined once every step is completed or skipped. */
  currentBedtimeStep: StoredRoutineStep | undefined;
  /** The next unfinished step of the wake routine for the most recently completed sleep, while it is
   * still open. */
  currentWakeStep: StoredRoutineStep | undefined;
  /** True once that sleep's own window (or its bedtime routine's) has opened. */
  sleepPanelDue: boolean;
  /** The sleep to act on: due by the clock, or brought forward by hand. */
  sleepDue: StoredSleepPlan | undefined;
  travelDirective: NowTravelDirective | null;
  resolution: NowActivityResolution<TCandidate, TProtected>;
  /**
   * `resolution` restated through the pulse resolver: the
   * same precedence, mapped onto the glossary's `doing` nouns instead of this module's own richer
   * kinds. `onPlan` and `offPlanSince` are never filled here — the criteria are not yet designed.
   */
  pulse: Pulse;
}

/**
 * The engine's sleep-directive floor (`directableSleep` in `selectCurrentDirective`): a zero-minute
 * window is never due, and a sliver under 30 minutes that already fails its own minimum is an
 * artifact of a wake-adjacent replan, not a rest to demand. Observed live as "Time to sleep" for a
 * 32-second block at 4:47 am. No surface may outrun the engine here.
 */
const SLEEP_SLIVER_MINUTES = 30;

function isSessionActive(session: ActiveSession | null): session is ActiveSession {
  return session !== null && (session.status === "running" || session.status === "paused");
}

/**
 * The earliest still-pending prerequisite of a routine step, walked transitively over
 * `dependencyIds` — undefined when every edge that gates a start is already satisfied. The same walk
 * the engine performs in `selectCurrentDirective`: step windows are static, so a prerequisite the
 * user ran late on drops out of the in-window filter while its dependent comes into window, and the
 * dependent is exactly the step the server's `start_activity` dependency gate would refuse.
 */
export function earliestUnmetPrerequisite(
  steps: StoredRoutineStep[],
  step: StoredRoutineStep
): StoredRoutineStep | undefined {
  const byId = new Map(steps.map((item) => [item.id, item]));
  const pending: StoredRoutineStep[] = [];
  const seen = new Set([step.id]);
  const queue = [...step.dependencyIds];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const prerequisite = byId.get(id);
    // A completed or skipped edge is satisfied; whatever sits behind it no longer gates this start.
    if (!prerequisite || prerequisite.status === "completed" || prerequisite.status === "skipped") continue;
    if (prerequisite.status === "pending") pending.push(prerequisite);
    queue.push(...prerequisite.dependencyIds);
  }
  return pending.sort(
    (a, b) => a.sequence - b.sequence || (a.scheduledStartAt ?? "").localeCompare(b.scheduledStartAt ?? "")
  )[0];
}

export function resolveNowActivity<
  TCandidate extends NowActivityCandidateLike,
  TProtected extends NowActivityProtectedLike
>({
  state,
  now,
  currentDirective,
  protectedCommitment,
  primary,
  manualBedtime = false
}: NowActivityInput<TCandidate, TProtected>): NowActivityBrain<TCandidate, TProtected> {
  // The engine's own verdict, held to one test: the id it names must still be a confirmed commitment
  // row, or a cancelled or edited commitment could keep a stale recommendation protecting time that
  // no longer exists.
  const storedProtected = protectedCommitment
    ? state.commitments.find((item) => item.id === protectedCommitment.id && item.status === "confirmed")
    : undefined;
  const protectedInfo: NowProtectedInfo<TProtected> | undefined =
    protectedCommitment && storedProtected ? { commitment: storedProtected, protectedCommitment } : undefined;

  // Routine steps still carry flat context tags, but they are judged by the same evaluator as
  // everything else rather than by a second implementation that only ever agreed with it by accident.
  // Unknown does not hide a step here: a step whose context nobody has answered is still offered,
  // because a missed preparation costs more than one shown at the wrong moment.
  const situation = resolveSituation({
    situation: state.currentSituation,
    definitions: state.conditionDefinitions,
    now,
    commitments: state.commitments
  });
  const stepContextsHold = (contexts: string[]) =>
    !contexts.length ||
    evaluateConditions({ pathways: [{ id: "step", contextIds: contexts }], resolved: situation }).status !== "no";

  // A commitment the engine has marked `late` still occupies `protectedInfo`, but its own
  // before-phase steps are exactly what is overdue — the routine-step machinery must still run for it
  // rather than being shut out by the ordinary "a protected commitment answers this by itself" rule,
  // which only ever held because an on-time commitment's steps are scheduled to finish before its
  // protection starts (see `routine-step-travel.test.ts`). Arrival or the commitment ending clears
  // `late` server-side, which is what lets this fall back to the ordinary gate.
  const routineStepsRunDespiteCommitment = !protectedInfo || Boolean(protectedInfo.protectedCommitment.late);

  // Availability comes from the engine's `scheduledStartAt`, never re-derived here. Computing a
  // flexible step's own window as `commitment.startsAt - maxLeadMinutes` ignored the schedule the
  // engine had already produced: a 900-minute lead surfaced tomorrow morning's "prepare uniform" at
  // three o'clock the previous afternoon. The lead window is an input to the engine's scheduler, not
  // a second opinion a surface is entitled to form.
  //
  // Nor does anything here require every earlier-sequence step to be ticked complete. The engine
  // walks the routine's real dependency edges when naming a step, so that cruder sequence rule only
  // ever hid the step the engine had named: an unticked breakfast buried "shower and get dressed"
  // behind "nothing fits" on a work morning.
  const directiveStepId = currentDirective?.kind === "routine_step" ? currentDirective.targetId : undefined;
  // Looked up by a step's `commitmentId`, mirroring the engine's own per-commitment bound
  // (`selectCurrentDirective`, directive.ts): the upper bound is the step's own `scheduledEndAt` *or*
  // its commitment's `endsAt` — an "or", not a replacement. An after-phase step ("unpack bag") is
  // still directable in its own window once its commitment has ended; a before-phase step of a
  // commitment running late is still directable once its own static window has elapsed, for as long
  // as that commitment has not itself ended. Only when both have closed is it the finished
  // commitment's own stale leftover.
  const commitmentEndsAtById = new Map(state.commitments.map((item) => [item.id, new Date(item.endsAt)]));
  // Same lookup, for arrival — mirrors the engine's own `stepMootOnArrival` (directive.ts): a
  // before-phase step's commitment may already have been reached even while the protected commitment
  // still reports it `late`, or names nothing at all, a beat behind the location assertion. A person
  // already at class was still offered "Pack Bag": the write-time skip
  // (`routine-step-arrival.ts`) missed its one edge-triggered chance, and this fallback, having no
  // notion of arrival, kept re-offering the step. Checked fresh on every call, exactly like the
  // engine, so this can never be a beat behind either. Only ever retires a before-phase step early —
  // "not arrived ⇒ still offer it" is unchanged.
  //
  // Mirrors `routineStepMootness` (engine/core/src/recommendation/routine-step-mootness.ts) —
  // `pnpm structure:check` forbids this package importing engine-core, so the same four rules are
  // reimplemented here rather than shared by import; keep the two in lockstep. `situation.locationId`
  // has already been through `resolveSituation`'s own staleness rule above, so it is treated as
  // already-fresh here rather than re-checked against a second staleness window. The addition versus
  // the old copy is the time bound (finding 20): a before-phase step of a *home-located* commitment
  // used to read as moot the instant the person was home — true most of the day — so it was excluded
  // from ever being offered, hours before its own routine block had opened. Now it is only moot inside
  // that commitment's own preparation window: at or after the earliest scheduled start among its
  // before-phase steps, and before the commitment itself ends.
  const commitmentLocationById = new Map(state.commitments.map((item) => [item.id, item.locationId ?? null]));
  const routineWindowStartByCommitmentId = new Map<string, Date>();
  for (const item of state.routineSteps) {
    if (item.phase !== "before" || !item.scheduledStartAt || !item.commitmentId) continue;
    const startsAt = new Date(item.scheduledStartAt);
    const existing = routineWindowStartByCommitmentId.get(item.commitmentId);
    if (!existing || startsAt < existing) routineWindowStartByCommitmentId.set(item.commitmentId, startsAt);
  }
  // No scheduled step means no window of its own: fall back to the commitment's own start, so a
  // routine the scheduler has not placed is still moot once the person is already there and the
  // commitment is underway. Without this, "unscheduled" would read as "never moot" and the
  // already-arrived "Pack Bag" bug would stand for those steps.
  for (const item of state.commitments) {
    if (routineWindowStartByCommitmentId.has(item.id)) continue;
    const startsAt = new Date(item.startsAt);
    if (!Number.isNaN(startsAt.getTime())) routineWindowStartByCommitmentId.set(item.id, startsAt);
  }
  const arrivedLocationId = situation.locationId;
  // A sleep-anchored step has no `commitmentId` at all, so every lookup below misses and this
  // returns `false` (never moot on arrival) — arrival-driven mootness is a commitment-only concept; a
  // bedtime/wake step has nowhere to "arrive at" (mirrors `stepMootOnArrival`, engine/core's directive.ts).
  const stepMootOnArrival = (item: StoredRoutineStep): boolean => {
    if (item.phase !== "before" || !item.commitmentId) return false;
    if (arrivedLocationId === null) return false;
    const locationId = commitmentLocationById.get(item.commitmentId);
    if (locationId == null || locationId !== arrivedLocationId) return false;
    const routineWindowStart = routineWindowStartByCommitmentId.get(item.commitmentId);
    const commitmentEndsAt = commitmentEndsAtById.get(item.commitmentId);
    if (!routineWindowStart || !commitmentEndsAt) return false;
    return now >= routineWindowStart && now < commitmentEndsAt;
  };
  // A sleep-anchored step has no commitment to fall back on, but the same idea applies: the whole
  // chain (every step sharing its `anchorId`/`purpose`) is owed until the chain's own overall end, not
  // just whichever one step's own slice `now` happens to fall in — mirrors `sleepAnchorEndsAtByKey` in
  // engine/core's `selectCurrentDirective` (directive.ts), fixed there for the identical reason: an
  // early step's own narrow window closing must not drop the whole routine out of the fallback net.
  const sleepAnchorEndsAtByKey = new Map<string, Date>();
  for (const item of state.routineSteps) {
    if (item.anchorType !== "sleep_plan" || !item.scheduledEndAt || item.status === "cancelled") continue;
    const key = `${item.anchorId}:${item.purpose}`;
    const endsAt = new Date(item.scheduledEndAt);
    const current = sleepAnchorEndsAtByKey.get(key);
    if (!current || endsAt > current) sleepAnchorEndsAtByKey.set(key, endsAt);
  }
  const inWindowFallbackStep = routineStepsRunDespiteCommitment
    ? state.routineSteps
        .filter((item) => {
          if (stepMootOnArrival(item)) return false;
          const availableAt = item.scheduledStartAt ? new Date(item.scheduledStartAt) : null;
          const chainEndsAt = item.commitmentId
            ? commitmentEndsAtById.get(item.commitmentId)
            : sleepAnchorEndsAtByKey.get(`${item.anchorId}:${item.purpose}`);
          const ownWindowOpen = !item.scheduledEndAt || new Date(item.scheduledEndAt) > now;
          const chainStillRunning = chainEndsAt !== undefined && chainEndsAt > now;
          const stillOwed = ownWindowOpen || chainStillRunning;
          return (
            item.status === "pending" &&
            availableAt &&
            availableAt <= now &&
            stillOwed &&
            stepContextsHold(item.contexts)
          );
        })
        .sort(
          (a, b) => (a.scheduledStartAt ?? "").localeCompare(b.scheduledStartAt ?? "") || a.sequence - b.sequence
        )[0]
    : undefined;
  const directiveStep = routineStepsRunDespiteCommitment
    ? state.routineSteps.find((item) => item.id === directiveStepId && item.status === "pending")
    : undefined;
  // The fallback mirrors the engine's own in-window filter, so it carries the same hole the engine
  // patches in `selectCurrentDirective`: an overdue prerequisite is out of window while its dependent
  // is in window, and the dependent's Start would be refused by the server's dependency gate. Apply
  // the same redirect, so the step offered is always one that can actually be started.
  const fallbackPrerequisite = inWindowFallbackStep
    ? earliestUnmetPrerequisite(state.routineSteps, inWindowFallbackStep)
    : undefined;
  const routineDue = directiveStep ?? fallbackPrerequisite ?? inWindowFallbackStep;
  const routineDueSource = directiveStep
    ? ("directive" as const)
    : fallbackPrerequisite
      ? ("prerequisite" as const)
      : inWindowFallbackStep
        ? ("fallback" as const)
        : undefined;

  const upcomingSleep = !protectedInfo
    ? state.sleepPlans
        .filter((item) => item.status === "planned" && new Date(item.plannedWakeAt) > now)
        .sort((a, b) => a.plannedStartAt.localeCompare(b.plannedStartAt))[0]
    : undefined;
  // One routine, one table: a bedtime/wake instance's `completedStepIds`/`skippedStepIds`
  // arrays and its own `planned`/`doing`/`completed`/`blocked` status are gone — the group of
  // `routine_steps` rows sharing this anchor and purpose carries the same facts per row now. "Still
  // open" is simply "has an unfinished step"; there is no longer a whole-instance status to check
  // (a session targets one step directly, never "the instance itself" — that concept no longer exists).
  const bedtimeGroup = upcomingSleep
    ? state.routineSteps
        .filter(
          (item) => item.anchorType === "sleep_plan" && item.anchorId === upcomingSleep.id && item.purpose === "bedtime"
        )
        .sort((a, b) => a.sequence - b.sequence)
    : [];
  const currentBedtimeStep = bedtimeGroup.find((step) => step.status !== "completed" && step.status !== "skipped");
  // No "same local day" re-check here: the engine only ever derives wake steps for a plan whose actual
  // wake fell on today (engine.ts's `wakeCandidates`), so a stale prior day's completed plan simply has
  // no matching group and `find` below returns undefined on its own.
  const recentlyWokenSleep = state.sleepPlans
    .filter((item) => item.status === "completed" && item.actualWakeAt)
    .sort((a, b) => (b.actualWakeAt ?? "").localeCompare(a.actualWakeAt ?? ""))[0];
  const wakeGroup = recentlyWokenSleep
    ? state.routineSteps
        .filter(
          (item) =>
            item.anchorType === "sleep_plan" && item.anchorId === recentlyWokenSleep.id && item.purpose === "wake"
        )
        .sort((a, b) => a.sequence - b.sequence)
    : [];
  const currentWakeStep = wakeGroup.find((step) => step.status !== "completed" && step.status !== "skipped");
  const sleepWindowViable = Boolean(
    upcomingSleep &&
    upcomingSleep.allowedMinutes > 0 &&
    (upcomingSleep.allowedMinutes >= SLEEP_SLIVER_MINUTES ||
      ((upcomingSleep.minimumShortfallMinutes ?? 0) === 0 && upcomingSleep.hardErrors.length === 0))
  );
  // `bedtimeGroup[0]` (sorted by sequence, so the earliest-starting step) stands in for the old
  // instance's own `startsAt` — its preparation can open before the plan's own `plannedStartAt`, and
  // that scheduled instant is unaffected by whichever step (if any) has since been completed or skipped.
  const sleepPanelDue = Boolean(
    sleepWindowViable &&
    upcomingSleep &&
    (new Date(upcomingSleep.plannedStartAt) <= now ||
      (bedtimeGroup[0]?.scheduledStartAt && new Date(bedtimeGroup[0].scheduledStartAt) <= now))
  );
  const sleepDue = sleepPanelDue || manualBedtime ? upcomingSleep : undefined;

  // The leg, its length, its source and what it is for are all stated by the engine. Nothing here
  // re-times a journey or re-decides whether it is worth making.
  const travelDirective = currentDirective?.kind === "travel" ? currentDirective : null;

  const resolution = resolveOne<TCandidate, TProtected>({
    session: state.activeSession,
    routineDue,
    routineDueSource,
    protectedInfo,
    travelDirective,
    // A hand-brought-forward bedtime is a Now-page affordance, not something on the clock: the
    // precedence chain only ever claims the moment for sleep whose own window has opened.
    sleepPanelDue: sleepPanelDue ? upcomingSleep : undefined,
    primary
  });

  // The same precedence, restated through the pulse resolver:
  // each rank above is handed to `resolvePulse` exactly as it applies here, and it owns the mapping
  // onto the glossary's `doing` nouns and the final ranking among them. `lastConfirmedAt` comes
  // straight off the session's own `lastVerifiedAt` (`portal/server/persistence/postgres/readers/sessions.ts`), never recomputed here.
  const pulse = resolvePulse({
    session: isSessionActive(state.activeSession)
      ? {
          targetType: (state.activeSession.targetType as PulseSessionTargetType | undefined) ?? "action",
          id: state.activeSession.targetId ?? state.activeSession.actionId,
          title: state.activeSession.targetTitle ?? ""
        }
      : undefined,
    travel: Boolean(travelDirective),
    routineStep: routineDue && routineDueSource ? { id: routineDue.id, title: routineDue.title } : undefined,
    commitment: protectedInfo ? { id: protectedInfo.commitment.id, title: protectedInfo.commitment.title } : undefined,
    // Sleep plans carry no title of their own; "Sleep" is the noun, not a directive imperative.
    sleep: sleepPanelDue && upcomingSleep ? { id: upcomingSleep.id, title: "Sleep" } : undefined,
    action: primary ? { id: primary.action.id, title: primary.action.title } : undefined,
    // On my way: while `underway` names the commitment
    // this travel leg is for, its own `departedAt` is a better pulse confirmation than the session's
    // `lastVerifiedAt` — a direct tap is stronger evidence than a periodic check-in answer.
    lastConfirmedAt:
      travelDirective && protectedInfo && state.currentSituation.underway?.commitmentId === protectedInfo.commitment.id
        ? state.currentSituation.underway.departedAt
        : state.activeSession?.lastVerifiedAt
  });

  return {
    protectedInfo,
    situation,
    routineStepsRunDespiteCommitment,
    routineDue,
    routineDueSource,
    upcomingSleep,
    currentBedtimeStep,
    currentWakeStep,
    sleepPanelDue,
    sleepDue,
    travelDirective,
    resolution,
    pulse
  };
}

function resolveOne<TCandidate extends NowActivityCandidateLike, TProtected extends NowActivityProtectedLike>(input: {
  session: ActiveSession | null;
  routineDue: StoredRoutineStep | undefined;
  routineDueSource: "directive" | "fallback" | "prerequisite" | undefined;
  protectedInfo: NowProtectedInfo<TProtected> | undefined;
  travelDirective: NowTravelDirective | null;
  sleepPanelDue: StoredSleepPlan | undefined;
  primary: TCandidate | null | undefined;
}): NowActivityResolution<TCandidate, TProtected> {
  if (isSessionActive(input.session)) return { kind: "session", session: input.session };
  if (input.travelDirective) return { kind: "travel", directive: input.travelDirective };
  // Ahead of the commitment, but only reachable at all when `routineStepsRunDespiteCommitment` let a
  // step through: with an on-time protected commitment there is no `routineDue` to consider here.
  if (input.routineDue && input.routineDueSource)
    return { kind: "routine_step", step: input.routineDue, source: input.routineDueSource };
  if (input.protectedInfo) return { kind: "commitment", ...input.protectedInfo };
  if (input.sleepPanelDue) return { kind: "sleep", plan: input.sleepPanelDue };
  if (input.primary) return { kind: "recommended", candidate: input.primary };
  return { kind: "free" };
}
