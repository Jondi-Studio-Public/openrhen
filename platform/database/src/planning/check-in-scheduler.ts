import { DEFAULT_LOCATION_STALE_AFTER_MINUTES, isClosedStatus } from "@openrhen/contracts";
import type postgres from "postgres";
import { currentFreshLocationId } from "./routine-step-mootness.js";
import { enqueueAgentWake } from "./agent-wake.js";
import { notifyStateChanged } from "./state-changed.js";
import { cancelCheckInWaitingPush, queueCheckInWaitingPush } from "../push/check-in-waiting-push.js";

/**
 * Periodic ground-truth sampling: "Still on X?" where X is the engine's own belief at the instant the
 * slot fires. Phase A is record-only — nothing here feeds back into planning, it only measures how
 * often the plan and reality agree.
 *
 * The scheduler is deliberately stateless across ticks: every decision is re-derived from the latest
 * `check_in` row and the engine's current belief, never from an in-memory "next due" clock. That is
 * what makes a worker restart harmless and a tick idempotent — the same inputs always produce the same
 * decision, which is also what makes `decideCheckInTick` a pure function worth unit-testing on its own.
 */

/** How long a pending slot waits for an answer before it is assumed unanswerable, never on-track. */
export const CHECK_IN_TIMEOUT_MINUTES = 10;

/**
 * The grace period after starting a task, switching to a different one, or finishing one, before the
 * scheduler may sample a new slot again. Without it, a fresh session (or a belief the plan just
 * changed its mind about) could be asked "Still on X?" before the person has had a chance to actually
 * get there — closing out the previous task, opening the next one, or just looking at Now to see what
 * changed. See `checkInCooldownUntil`.
 */
export const CHECK_IN_COOLDOWN_MINUTES = 5;

export type CheckInDirectiveKind =
  | "action"
  | "sleep"
  // Covers both anchors: a commitment's own preparation step and a bedtime/wake step alike,
  // since both are `routine_steps` rows now. `routine_instance` dropped.
  | "routine_step"
  | "deliverable"
  | "travel"
  /** The clock is held for a blocking commitment — `currentDirective.kind` is 'none' either way. */
  | "protected_commitment"
  /** An anchor commitment's own window is open with nothing else claiming the moment. */
  | "open_anchor";

/** The five `currentDirective` kinds that name something a person could actually still be doing. */
const DIRECTABLE_KINDS = new Set<string>(["action", "sleep", "routine_step", "deliverable", "travel"]);

/** The belief snapshot frozen onto a `check_in` row at the moment its slot fires. */
export interface CheckInBeliefSnapshot {
  kind: CheckInDirectiveKind;
  targetId: string | null;
  title: string;
  phase: string | null;
  /** Only ever populated for `kind: "travel"` — the place the leg is headed to, so the staleness guard
   * below can tell whether the person has already arrived since the plan run this belief came from. */
  toLocationId: string | null;
}

/** The shape read off `planning_runs.result->'currentDirective'`, loosely — this is stored JSON. */
export interface RawCurrentDirective {
  kind: string;
  targetId?: string;
  title?: string;
  then?: { targetId?: string };
  /** Present only when `kind === "travel"` (`directive.ts`'s `travelDirective`). */
  toLocationId?: string;
}

/** The shape read off `recommendation.protectedCommitment` / `.openAnchor`, loosely. */
export interface RawProtectedCommitment {
  id: string;
  title: string;
  phase: string;
}

/**
 * A running session's own target, read straight off `sessions.target_type`/`target_id`/`target_title`
 * — what the person is actually doing right now, as opposed to `currentDirective`/`protectedCommitment`
 * /`openAnchor`, which are only the stored plan run's guess from whenever it was last calculated. A
 * session is a direct assertion; the stored plan is not.
 */
export interface RawActiveSessionTarget {
  targetType: string;
  targetId: string | null;
  targetTitle: string | null;
}

/**
 * How a session's own `target_type` maps onto a belief kind a check-in can ask "still on X?" about.
 * `fixed_commitment` maps to `protected_commitment` — a session against a commitment is definitionally
 * "on" it, the same status a stored plan run would have folded it into had it come from there instead
 * (see the kind's own doc comment above). Every other mapped type's session target-type name already
 * matches its belief kind's name directly. `sleep` is deliberately absent: a session tracking sleep
 * already forces `isSleepWindow` to silence the scheduler before any belief is needed, so it never has
 * to resolve to one. Anything else absent (there is nothing else today) falls through to the stored
 * belief rather than to null — see `deriveBeliefSnapshot` below.
 */
const SESSION_TARGET_BELIEF_KIND: Partial<Record<string, CheckInDirectiveKind>> = {
  action: "action",
  deliverable: "deliverable",
  routine_step: "routine_step",
  fixed_commitment: "protected_commitment"
};

/**
 * What to snapshot as the check-in's subject, or null when nothing about this instant is worth asking
 * about. An active session's own target takes precedence over everything else here when it names
 * something directable — a running session is a direct assertion of what the person is doing, while
 * `currentDirective`/`protectedCommitment`/`openAnchor` are only the stored plan run's guess, which can
 * already disagree with reality by the time this fires (the plan hasn't been recalculated since a
 * switch, or picked something it never anticipated). A session target with no directable belief
 * representation (`SESSION_TARGET_BELIEF_KIND` has no entry for it) falls through to the stored belief
 * below instead, never to null — the session not naming something askable is not the same as there
 * being nothing to ask about.
 *
 * Absent that override, `currentDirective` covers the six ordinary kinds directly; a held or open
 * commitment is folded in as two further kinds because an ordinary `currentDirective.kind` of 'none'
 * says nothing by itself about *why* — see `directive.ts`'s `selectCurrentDirective`, where a blocking
 * protected commitment and "nothing fits at all" both produce 'none'. `recovery`, `answer`, `boundary`
 * and a `protectedCommitment`-less/`openAnchor`-less 'none' have nothing meaningful to ask "still on"
 * about, so they fall through to null rather than being forced into a question that doesn't parse.
 */
export function deriveBeliefSnapshot(
  currentDirective: RawCurrentDirective | null | undefined,
  protectedCommitment: RawProtectedCommitment | null | undefined,
  openAnchor: RawProtectedCommitment | null | undefined,
  activeSessionTarget?: RawActiveSessionTarget | null
): CheckInBeliefSnapshot | null {
  if (activeSessionTarget?.targetId) {
    const sessionKind = SESSION_TARGET_BELIEF_KIND[activeSessionTarget.targetType];
    if (sessionKind) {
      return {
        kind: sessionKind,
        targetId: activeSessionTarget.targetId,
        title: activeSessionTarget.targetTitle ?? "",
        phase: null,
        toLocationId: null
      };
    }
  }
  const kind = currentDirective?.kind;
  if (kind && DIRECTABLE_KINDS.has(kind)) {
    return {
      kind: kind as CheckInDirectiveKind,
      targetId: currentDirective!.targetId ?? currentDirective!.then?.targetId ?? null,
      title: currentDirective!.title ?? "",
      phase: null,
      toLocationId: kind === "travel" ? (currentDirective!.toLocationId ?? null) : null
    };
  }
  if (protectedCommitment) {
    return {
      kind: "protected_commitment",
      targetId: protectedCommitment.id,
      title: protectedCommitment.title,
      phase: protectedCommitment.phase,
      toLocationId: null
    };
  }
  if (openAnchor) {
    return {
      kind: "open_anchor",
      targetId: openAnchor.id,
      title: openAnchor.title,
      phase: openAnchor.phase,
      toLocationId: null
    };
  }
  return null;
}

/** Sleep silences the scheduler by reading the sleep window directly — never through `prompt_policy`. */
export function isSleepWindow(
  currentDirective: RawCurrentDirective | null | undefined,
  activeSessionTargetType: string | null
): boolean {
  return currentDirective?.kind === "sleep" || activeSessionTargetType === "sleep";
}

export type CheckInCadence = "base" | "hourly";

/** 'reduced' or an actively tracked session both mean fewer interruptions than the ordinary cadence. */
export function cadenceFor(promptPolicy: "silent" | "reduced" | "normal", hasActiveSession: boolean): CheckInCadence {
  return promptPolicy === "reduced" || hasActiveSession ? "hourly" : "base";
}

function fnv1a(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967296;
}

function uniform(min: number, max: number, unit: number): number {
  return min + unit * (max - min);
}

/**
 * Minutes until the next slot, jittered per-slot so prompts cannot be anticipated: base cadence draws
 * uniform(15,20) then adds a further uniform(-5,5); hourly draws the same jitter around 60.
 *
 * Seeded from `seed` (the resolved row's id, or a fixed cold-start seed) rather than `Math.random()`,
 * so the same resolved slot always recomputes the same next-due instant no matter how many ticks pass
 * before it is reached — the scheduler has no other place to remember a random draw across restarts.
 */
export function jitteredIntervalMinutes(cadence: CheckInCadence, seed: string): number {
  const base = cadence === "hourly" ? 60 : uniform(15, 20, fnv1a(`${seed}:base`));
  const jitter = uniform(-5, 5, fnv1a(`${seed}:jitter`));
  return Math.max(1, Math.round(base + jitter));
}

export interface LatestCheckInRow {
  id: string;
  status: "pending" | "on_track" | "deviated" | "unknown" | "superseded";
  promptedAt: Date | null;
  createdAt: Date;
  answeredAt: Date | null;
  updatedAt: Date;
  /** When this row's belief was snapshotted — `slot_at` doubles as both, see the column's own comment. */
  slotAt: Date;
  directiveKind: string;
  directiveTargetId: string | null;
}

export interface CheckInTickInput {
  now: Date;
  /** The most recent `check_in` row for this user, of any status, or null if there has never been one. */
  latest: LatestCheckInRow | null;
  sleeping: boolean;
  /** The prompt policy of the active protected/open-anchor commitment, or null when there is none. */
  activeCommitmentPromptPolicy: "silent" | "reduced" | "normal" | null;
  hasActiveSession: boolean;
  belief: CheckInBeliefSnapshot | null;
  /** When the currently active session (if any) started — the first cooldown anchor. */
  activeSessionStartedAt: Date | null;
  /** When the most recently ended session (if any) ended — the third cooldown anchor. */
  lastSessionEndedAt: Date | null;
}

export type CheckInTickResult =
  | { action: "wait" }
  | { action: "timeout"; rowId: string }
  | { action: "skip" }
  | { action: "create"; belief: CheckInBeliefSnapshot };

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

export interface CheckInCooldownInput {
  now: Date;
  /** When the currently active session (if any) started, or null when nothing is currently tracked. */
  activeSessionStartedAt: Date | null;
  /** When the most recently ended session (if any) ended, or null when none has ever ended. */
  lastSessionEndedAt: Date | null;
  /** The engine's current belief, or null when there is nothing to ask about right now. */
  belief: CheckInBeliefSnapshot | null;
  /** The belief stamped on the most recent check-in row (any status), or null if there has never been one. */
  latestBelief: { kind: string; targetId: string | null } | null;
  /** When that most recent row's belief was snapshotted (its `slot_at`), or null alongside `latestBelief`. */
  latestBeliefAt: Date | null;
}

/**
 * The earliest instant a check-in slot may next fire, given three independent grace-period anchors —
 * a session that just started, a session that just ended, or the plan's belief about what's current
 * having just changed. Each anchor that applies pushes the floor to `CHECK_IN_COOLDOWN_MINUTES` after
 * its own instant; the result is the latest of whichever anchors apply (or the epoch, meaning no floor
 * at all, when none do).
 *
 * Callers apply this as `max(nextSlot, checkInCooldownUntil(...))`, never in place of `nextSlot` —
 * that is what lets the ordinary jittered cadence resume wherever it would otherwise have landed once
 * the grace period has passed, rather than every cooldown forcing a slot to fire the instant it ends.
 */
export function checkInCooldownUntil(input: CheckInCooldownInput): Date {
  const { activeSessionStartedAt, lastSessionEndedAt, belief, latestBelief, latestBeliefAt } = input;
  let floor = new Date(0);

  if (activeSessionStartedAt) {
    const until = addMinutes(activeSessionStartedAt, CHECK_IN_COOLDOWN_MINUTES);
    if (until > floor) floor = until;
  }
  if (lastSessionEndedAt) {
    const until = addMinutes(lastSessionEndedAt, CHECK_IN_COOLDOWN_MINUTES);
    if (until > floor) floor = until;
  }
  // A change of what the plan thinks you're on starts its own fresh grace period — but only while
  // there is a prior belief to have changed from and a timestamp to measure the change's own age.
  const beliefChanged =
    belief !== null &&
    latestBelief !== null &&
    (belief.kind !== latestBelief.kind || belief.targetId !== latestBelief.targetId);
  if (beliefChanged && latestBeliefAt) {
    const until = addMinutes(latestBeliefAt, CHECK_IN_COOLDOWN_MINUTES);
    if (until > floor) floor = until;
  }
  return floor;
}

/**
 * Queues the `check_in_unanswered` wake unless the previous one has gone unanswered: no new wake while
 * no check-in has been answered (on track or deviated) since the previous wake was queued.
 */
async function enqueueCheckInWake(sql: postgres.Sql, userId: string, checkInId: string, now: Date): Promise<void> {
  const unansweredBefore = await sql<{ id: string }[]>`
    SELECT w.id FROM agent_wakes w
    WHERE w.user_id=${userId} AND w.event='check_in_unanswered'
      AND w.created_at = (SELECT max(created_at) FROM agent_wakes WHERE user_id=${userId} AND event='check_in_unanswered')
      AND NOT EXISTS (
        SELECT 1 FROM check_in c
        WHERE c.user_id=${userId} AND c.status IN ('on_track','deviated') AND c.answered_at > w.created_at
      )`;
  if (unansweredBefore.length > 0) return;
  await enqueueAgentWake(sql, { userId, event: "check_in_unanswered", targetId: checkInId, now });
}

/**
 * One user's tick: resolve a timed-out pending slot, wait on one still in its window, or decide
 * whether a new one is due — gated by sleep, a silenced commitment, the post-transition cooldown, and
 * there being anything meaningful to ask about.
 *
 * Never two pending: a `pending` row is always the first branch, so a new one is never even
 * considered while one is outstanding. The database's own partial unique index is the backstop for a
 * race this single-threaded check cannot itself create.
 */
export function decideCheckInTick(input: CheckInTickInput): CheckInTickResult {
  const { now, latest } = input;
  if (latest?.status === "pending") {
    const since = latest.promptedAt ?? latest.createdAt;
    const ageMinutes = (now.getTime() - since.getTime()) / 60_000;
    return ageMinutes >= CHECK_IN_TIMEOUT_MINUTES ? { action: "timeout", rowId: latest.id } : { action: "wait" };
  }
  // Epoch when there is no history at all, so a brand-new user's first slot is due immediately
  // (subject to the same gates as any other) rather than waiting out a cadence with nothing behind it.
  const resolvedAt = latest ? (latest.answeredAt ?? latest.updatedAt) : new Date(0);
  const cadence = cadenceFor(input.activeCommitmentPromptPolicy ?? "normal", input.hasActiveSession);
  const nextSlot = new Date(
    resolvedAt.getTime() + jitteredIntervalMinutes(cadence, latest?.id ?? "cold-start") * 60_000
  );
  const cooldownUntil = checkInCooldownUntil({
    now,
    activeSessionStartedAt: input.activeSessionStartedAt,
    lastSessionEndedAt: input.lastSessionEndedAt,
    belief: input.belief,
    latestBelief: latest ? { kind: latest.directiveKind, targetId: latest.directiveTargetId } : null,
    latestBeliefAt: latest?.slotAt ?? null
  });
  const dueAt = cooldownUntil > nextSlot ? cooldownUntil : nextSlot;
  if (now < dueAt) return { action: "wait" };
  if (input.sleeping) return { action: "skip" };
  if (input.activeCommitmentPromptPolicy === "silent") return { action: "skip" };
  if (!input.belief) return { action: "skip" };
  return { action: "create", belief: input.belief };
}

/**
 * The freshness-aware location assertion, read straight off `user_preferences` — the same rule
 * `sweepMootRoutineSteps` applies, shared here so the routine_step and travel staleness guards below
 * agree with each other and with the sweep about what counts as "actually there right now".
 */
async function currentlyArrivedLocationId(sql: postgres.Sql, userId: string, now: Date): Promise<string | null> {
  const situationRows = await sql<{ current_situation: unknown }[]>`
    SELECT current_situation FROM user_preferences WHERE user_id=${userId}
  `;
  // `location_stale_after_minutes` was a per-user column nothing could ever write (no portal form, no
  // CLI field) and was always the same 480; dropped, so the constant is now the only value there is.
  return currentFreshLocationId(situationRows[0]?.current_situation, now, DEFAULT_LOCATION_STALE_AFTER_MINUTES);
}

interface BeliefInputs {
  currentDirective: RawCurrentDirective | null;
  protectedCommitment: RawProtectedCommitment | null;
  openAnchor: RawProtectedCommitment | null;
  sessionRows: {
    target_type: string;
    target_id: string | null;
    target_title: string | null;
    started_at: Date | null;
  }[];
}

/** The stored plan run's belief fields and the open session, read cheaply (no plan run, no HTTP to the engine). */
async function readBeliefInputs(sql: postgres.Sql, userId: string): Promise<BeliefInputs> {
  const planningRows = await sql<
    {
      current_directive: RawCurrentDirective | null;
      protected_commitment: RawProtectedCommitment | null;
      open_anchor: RawProtectedCommitment | null;
    }[]
  >`
    SELECT result->'currentDirective' AS current_directive,
      result->'recommendation'->'protectedCommitment' AS protected_commitment,
      result->'recommendation'->'openAnchor' AS open_anchor
    FROM planning_runs WHERE user_id=${userId} AND superseded_at IS NULL
  `;
  const sessionRows = await sql<BeliefInputs["sessionRows"]>`
    SELECT target_type, target_id, target_title, started_at FROM sessions
    WHERE user_id=${userId} AND ended_at IS NULL AND status IN ('running','paused','awaiting_feedback')
    ORDER BY created_at DESC LIMIT 1
  `;
  return {
    currentDirective: planningRows[0]?.current_directive ?? null,
    protectedCommitment: planningRows[0]?.protected_commitment ?? null,
    openAnchor: planningRows[0]?.open_anchor ?? null,
    sessionRows
  };
}

/**
 * What the engine believes the person is doing right now, as a slot would snapshot it, or null when it
 * believes nothing askable. The same read and derivation the scheduler tick uses; a voluntary check-in
 * (`portal/.../check-in-commands.ts`) snapshots it too.
 */
export async function readCurrentBelief(sql: postgres.Sql, userId: string): Promise<CheckInBeliefSnapshot | null> {
  const inputs = await readBeliefInputs(sql, userId);
  const session = inputs.sessionRows[0];
  return deriveBeliefSnapshot(
    inputs.currentDirective,
    inputs.protectedCommitment,
    inputs.openAnchor,
    session ? { targetType: session.target_type, targetId: session.target_id, targetTitle: session.target_title } : null
  );
}

/**
 * Runs one tick for one user against the real database: reads the engine's current belief and the
 * active session cheaply (no plan run, no HTTP to the engine service), decides, and applies.
 */
export async function runCheckInSchedulerTick(sql: postgres.Sql, userId: string, now: Date): Promise<void> {
  const { currentDirective, protectedCommitment, openAnchor, sessionRows } = await readBeliefInputs(sql, userId);

  const hasActiveSession = sessionRows.length > 0;
  const activeSessionStartedAt = sessionRows[0]?.started_at ?? null;
  const sleeping = isSleepWindow(currentDirective, sessionRows[0]?.target_type ?? null);
  // What the session itself asserts, so `deriveBeliefSnapshot` below can prefer it over the stored
  // plan run's guess — see that function's own doc comment for why.
  const activeSessionTarget: RawActiveSessionTarget | null = sessionRows[0]
    ? {
        targetType: sessionRows[0].target_type,
        targetId: sessionRows[0].target_id,
        targetTitle: sessionRows[0].target_title
      }
    : null;

  // The other two cooldown anchors: the moment the active session began (above) and the moment the
  // most recently *ended* session finished — read separately since a session that has already ended
  // no longer shows up in the `ended_at IS NULL` query just above.
  const lastEndedSessionRows = await sql<{ ended_at: Date }[]>`
    SELECT ended_at FROM sessions
    WHERE user_id=${userId} AND ended_at IS NOT NULL
    ORDER BY ended_at DESC LIMIT 1
  `;
  const lastSessionEndedAt = lastEndedSessionRows[0]?.ended_at ?? null;

  // The session's own commitment wins here for the same reason it wins in `deriveBeliefSnapshot`: its
  // prompt policy and its cancelled/ended status are the ones that govern a check-in about it, not
  // those of whichever commitment the stored plan run happened to be holding.
  const activeCommitmentId =
    (activeSessionTarget?.targetType === "fixed_commitment" ? activeSessionTarget.targetId : null) ??
    protectedCommitment?.id ??
    openAnchor?.id ??
    null;
  let activeCommitmentPromptPolicy: "silent" | "reduced" | "normal" | null = null;
  // Carries status/ends_at alongside the prompt policy this row was already being fetched for, so the
  // protected_commitment/open_anchor staleness guard below (finding 41) can reuse this same read rather
  // than a second query.
  let activeCommitmentRow: { status: string; ends_at: Date } | null = null;
  if (activeCommitmentId) {
    const commitmentRows = await sql<
      { prompt_policy: "silent" | "reduced" | "normal"; status: string; ends_at: Date }[]
    >`
      SELECT prompt_policy, status, ends_at FROM commitments WHERE id=${activeCommitmentId} AND user_id=${userId}
    `;
    activeCommitmentPromptPolicy = commitmentRows[0]?.prompt_policy ?? null;
    activeCommitmentRow = commitmentRows[0]
      ? { status: commitmentRows[0].status, ends_at: commitmentRows[0].ends_at }
      : null;
  }

  const belief = deriveBeliefSnapshot(currentDirective, protectedCommitment, openAnchor, activeSessionTarget);

  const latestRows = await sql<
    {
      id: string;
      status: LatestCheckInRow["status"];
      prompted_at: Date | null;
      created_at: Date;
      answered_at: Date | null;
      updated_at: Date;
      slot_at: Date;
      directive_kind: string;
      directive_target_id: string | null;
    }[]
  >`
    SELECT id,status,prompted_at,created_at,answered_at,updated_at,slot_at,directive_kind,directive_target_id FROM check_in
    WHERE user_id=${userId} ORDER BY created_at DESC LIMIT 1
  `;
  const latestRow = latestRows[0];
  const latest: LatestCheckInRow | null = latestRow
    ? {
        id: latestRow.id,
        status: latestRow.status,
        promptedAt: latestRow.prompted_at,
        createdAt: latestRow.created_at,
        answeredAt: latestRow.answered_at,
        updatedAt: latestRow.updated_at,
        slotAt: latestRow.slot_at,
        directiveKind: latestRow.directive_kind,
        directiveTargetId: latestRow.directive_target_id
      }
    : null;

  const decision = decideCheckInTick({
    now,
    latest,
    sleeping,
    activeCommitmentPromptPolicy,
    hasActiveSession,
    belief,
    activeSessionStartedAt,
    lastSessionEndedAt
  });

  if (decision.action === "timeout") {
    const flipped = await sql<{ id: string }[]>`
      UPDATE check_in SET status='unknown', updated_at=CURRENT_TIMESTAMP
      WHERE id=${decision.rowId} AND status='pending' RETURNING id`;
    // The question closed unanswered, so a push still waiting for it must not arrive late.
    if (flipped.length > 0) await cancelCheckInWaitingPush(sql, userId, flipped[0]!.id);
    // Wake the owner's agent only when this tick made the flip
    // (a racing answer makes none), the owner is not asleep, and the commitment does not ask for silence.
    // Not in a transaction with the flip: a crash between them loses one wake, which is harmless.
    if (flipped.length > 0 && !sleeping && activeCommitmentPromptPolicy !== "silent") {
      await enqueueCheckInWake(sql, userId, flipped[0]!.id, now);
    }
    // A timed-out slot flips straight to 'unknown' — still a status `/api/check-ins/current` reports
    // and a banner worth showing — so a listening tab should learn about this the same way it learns
    // about a freshly created slot below.
    notifyStateChanged(sql, { userId, kind: "check_in" });
    return;
  }
  if (decision.action !== "create") return;
  // `belief` is a snapshot of the plan run's own `currentDirective`, which can already be a beat
  // behind the actual row by the time this tick fires — the same class of gap:
  // the write-time skip (`routine-step-arrival.ts`) or the read-time mootness check
  // (`directive.ts`'s `stepMootOnArrival`) may have moved on since the plan was last calculated, but
  // this scheduler reads the stored run, not a fresh call into the engine. A "Still on Pack Bag?"
  // check-in snapshotting a belief that was already stale at the moment it was written (the report's
  // own second check-in did exactly this) is worse than skipping the slot for one tick: it manufactures
  // a false ground-truth sample and asks a question whose premise nobody watching the plan would still
  // agree with.
  //
  // Finding 41: this originally only re-validated `routine_step`. Every kind `decideCheckInTick` can
  // actually reach "create" with is covered below, one narrow, cheap check apiece:
  //   - routine_step: its own status, plus (a commitment-anchored row only) arrival at its commitment's
  // location — a sleep-anchored row has no location to be stale about.
  //   - action / deliverable: the same "already resolved" reasoning as routine_step's own status
  //     check — nothing about location, just whatever row backs the belief having since finished, in
  //     the enum's terms for that table.
  //   - travel: the location-arrival half of the routine_step check, applied to the leg's destination —
  //     a travel directive is moot the instant the person is already there, exactly like a routine step.
  //   - protected_commitment / open_anchor: reuses the `commitments` row already fetched above for
  //     its prompt policy — cancelled, or already past its own `ends_at`, means asking "still on X?" asks
  //     about a commitment that is no longer live.
  //   - sleep: never reaches here stale. `decideCheckInTick` gates on `input.sleeping`, computed from
  //     this exact same possibly-stale `currentDirective` (`isSleepWindow`), and a belief of kind "sleep"
  //     can only exist when `currentDirective.kind === "sleep"` (`deriveBeliefSnapshot` copies it
  //     directly) — so `sleeping` is already true and the tick returned `{action:"skip"}` before ever
  //     reaching "create". Structurally unreachable, not an oversight.
  const target = decision.belief;
  if (target.kind === "routine_step" && target.targetId) {
    // `routine_step` now covers a bedtime/wake step the same as a commitment's own (
    // The one routine storage design note) — `LEFT JOIN`, since a sleep-anchored row's `commitment_id`
    // is null and has no location to be stale about.
    const stepRows = await sql<{ status: string; commitment_location_id: string | null }[]>`
      SELECT s.status, c.location_id AS commitment_location_id
      FROM routine_steps s
      LEFT JOIN commitments c ON c.id = s.commitment_id
      WHERE s.id=${target.targetId} AND s.user_id=${userId}
    `;
    const step = stepRows[0];
    if (!step || step.status === "completed" || step.status === "skipped") return;
    if (step.commitment_location_id) {
      // Staleness-aware for the same reason `sweepMootRoutineSteps` is: a Monday "at class" assertion
      // is not evidence the person is there now, so it must not suppress today's "Still on Pack Bag?"
      // check-in either.
      const arrivedLocationId = await currentlyArrivedLocationId(sql, userId, now);
      if (arrivedLocationId && arrivedLocationId === step.commitment_location_id) return;
    }
  }
  if (target.kind === "action" && target.targetId) {
    // Actions have no `user_id` column of their own — ownership is established the same way
    // `plan-forecast-runtime.ts`'s occurrence prune already does, through the area at the top of the
    // hierarchy (single-tenant today, but this is the join every other action-by-user lookup here uses).
    const rows = await sql<{ status: string }[]>`
      SELECT ac.status FROM actions ac
        JOIN projects p ON p.id=ac.project_id
        JOIN outcomes o ON o.id=p.outcome_id
        JOIN areas a ON a.id=o.area_id
      WHERE ac.id=${target.targetId} AND a.user_id=${userId}
    `;
    const status = rows[0]?.status;
    if (!rows[0] || status === "done" || isClosedStatus(status)) return;
  }
  if (target.kind === "deliverable" && target.targetId) {
    const rows = await sql<{ status: string }[]>`
      SELECT d.status FROM deliverables d
        JOIN projects p ON p.id=d.project_id
        JOIN outcomes o ON o.id=p.outcome_id
        JOIN areas a ON a.id=o.area_id
      WHERE d.id=${target.targetId} AND a.user_id=${userId}
    `;
    const status = rows[0]?.status;
    if (!rows[0] || status === "completed" || isClosedStatus(status)) return;
  }
  if (target.kind === "travel" && target.toLocationId) {
    const arrivedLocationId = await currentlyArrivedLocationId(sql, userId, now);
    if (arrivedLocationId && arrivedLocationId === target.toLocationId) return;
  }
  if (
    (target.kind === "protected_commitment" || target.kind === "open_anchor") &&
    activeCommitmentRow &&
    (activeCommitmentRow.status === "cancelled" || activeCommitmentRow.ends_at <= now)
  )
    return;
  await sql.begin(async (transaction) => {
    const tx = transaction as unknown as postgres.Sql;
    // Never two pending: a defensive supersede immediately before the insert, so a race that slipped
    // past the single-threaded check above still cannot leave two rows open. The database's partial
    // unique index (`check_in_one_pending_per_user`) is what makes this actually hold, not this line.
    const superseded = await tx<
      { id: string }[]
    >`UPDATE check_in SET status='superseded', updated_at=CURRENT_TIMESTAMP WHERE user_id=${userId} AND status='pending' RETURNING id`;
    for (const row of superseded) await cancelCheckInWaitingPush(tx, userId, row.id);
    const created = await tx<{ id: string }[]>`
      INSERT INTO check_in (user_id, slot_at, directive_kind, directive_target_id, directive_phase, directive_title, status)
      VALUES (${userId}, ${now}, ${decision.belief.kind}, ${decision.belief.targetId}, ${decision.belief.phase}, ${decision.belief.title}, 'pending')
      RETURNING id
    `;
    // Queued with the slot, so it only exists where the scheduler decided to ask (not asleep, not silent, something askable).
    await queueCheckInWaitingPush(tx, {
      userId,
      checkInId: created[0]!.id,
      expiresAt: new Date(now.getTime() + CHECK_IN_TIMEOUT_MINUTES * 60_000),
      title: decision.belief.title
    });
  });
  // Fired only once the transaction above has committed, on the outer (pooled) `sql`, not `tx` — a
  // notification sent on a connection whose transaction later rolled back would never actually fire
  // (Postgres defers `NOTIFY` to commit), but here the transaction is already known to have committed
  // by the time control reaches this line.
  notifyStateChanged(sql, { userId, kind: "check_in" });
}
