import {
  DEFAULT_TIMEZONE,
  advancePulse,
  judgePulse,
  localMidnightUtc,
  planForecastResponseSchema,
  resolveCheckInExtraMinutes,
  resolveFreshness,
  DEFAULT_CHECK_IN_TIMEOUT_MINUTES,
  type PortalStateContract,
  resolveExpectedSilence,
  type ContactEvent,
  type ContactSource,
  type ExpectedSilenceWindow,
  commitmentFreedAt,
  type JudgeCheckIn,
  type JudgeDayPlanBlock,
  type JudgeDirective,
  type JudgePulseInput,
  type PlanForecastResponse,
  type PulseJudgement,
  type PulseMachineMemory,
  type PulseMachineResult,
  type PulseMachineState,
  type PulseSegmentReason,
  type PulseTarget,
  type PulseTargetKind,
  type SessionSanction,
  type UsableDisruption
} from "@openrhen/contracts";
import { cancelPendingUnknownWakes, enqueueAgentWake } from "@openrhen/database";
import { queueBackOnPlanPush } from "./back-on-plan-push";
import { ensureUser } from "../persistence/postgres/ensure-user";
import type { PoolSql, TxSql } from "../persistence/postgres/sql-pool";

/**
 * The pulse criteria and publish design note ("Recording"): builds the judge's input from one state
 * read, judges, and writes `pulse_segments`/`pulse_state`. This is the recorder — the one place that
 * turns the judge's pure decision into recorded history.
 *
 * The outage-gap window (`pulse_state.last_evaluated_at` older than this counts as an outage) — the
 * design's own "over 5 minutes old".
 */
const GAP_THRESHOLD_MS = 5 * 60_000;

/** How the recorder maps a session's `target_type` onto a pulse target kind — mirrors
    `PULSE_SESSION_DOING_KIND` in `pulse.ts`, but `routine_instance` (no pulse noun) drops the session
    from consideration entirely, matching that module's own precedent. */
const SESSION_TARGET_KIND: Partial<Record<string, PulseTargetKind>> = {
  action: "action",
  deliverable: "deliverable",
  routine_step: "step",
  fixed_commitment: "commitment",
  sleep: "sleep"
};

/** How a `check_in.directive_kind` maps onto a pulse target kind — mirrors `CheckInDirectiveKind`
    (`platform/database/src/planning/check-in-scheduler.ts`). Kinds naming no target (there are none
    today) would drop out here the same way. */
const CHECK_IN_TARGET_KIND: Record<string, PulseTargetKind> = {
  action: "action",
  deliverable: "deliverable",
  routine_step: "step",
  sleep: "sleep",
  travel: "journey",
  protected_commitment: "commitment",
  open_anchor: "commitment"
};

interface OpenSegmentRow {
  id: string;
  startedAt: Date;
  state: string;
  reason: string | null;
  doingKind: string | null;
  doingId: string | null;
  doingTitle: string | null;
  expectedKind: string | null;
  expectedId: string | null;
  private: boolean;
}

function targetKey(kind: string | null, id: string | null): string {
  return kind && id ? `${kind}:${id}` : "";
}

/** What a segment records: the machine's state and reason layered over the judge's doing/expected/private. */
interface SegmentShape {
  state: PulseMachineState;
  reason: PulseSegmentReason;
  doing: PulseTarget | undefined;
  expected: PulseTarget | undefined;
  private: boolean;
  /** Who made the confirmation behind an `on` segment (`schedule` for `on/scheduled`). */
  source: ContactSource | null;
  confirmedAt: Date | null;
}

/**
 * The segment `result` describes. `unknown` is recorded as state
 * `unknown`, reason `unconfirmed`; `off` is always `off/lapsed` (the judge's `deviated`, `unsanctioned`
 * and `overran` are either a recorded disruption, `on/disrupted`, or a lapse). `on/scheduled` holds the
 * silent commitment as what he is doing.
 */
function segmentShape(result: PulseMachineResult, judgement: PulseJudgement): SegmentShape {
  const base = { private: judgement.private, expected: judgement.expected };
  switch (result.state) {
    case "on":
      return {
        ...base,
        state: "on",
        reason: result.onReason ?? "confirmed",
        doing: result.onReason === "scheduled" ? (judgement.doing ?? judgement.expected) : judgement.doing,
        source: result.onReason === "scheduled" ? "schedule" : result.confirmedBy,
        confirmedAt:
          result.onReason === "confirmed" ? (judgement.confirmedAt ?? result.lastConfirmedAt) : result.lastConfirmedAt
      };
    case "unknown":
      return { ...base, state: "unknown", reason: "unconfirmed", doing: undefined, source: null, confirmedAt: null };
    case "off":
      return { ...base, state: "off", reason: "lapsed", doing: judgement.doing, source: null, confirmedAt: null };
    case "free":
      return { ...base, state: "free", reason: "free", doing: judgement.doing, source: null, confirmedAt: null };
    case "asleep":
      return { ...base, state: "asleep", reason: "asleep", doing: undefined, source: null, confirmedAt: null };
  }
}

/** Whether `shape` differs from the open segment in any field the design names ("state, reason,
    doing, expected or private"). */
function shapeDiffersFromOpen(shape: SegmentShape, open: OpenSegmentRow): boolean {
  if (shape.state !== open.state || shape.reason !== open.reason || shape.private !== open.private) return true;
  const doingKey = shape.doing ? `${shape.doing.kind}:${shape.doing.id}` : "";
  if (doingKey !== targetKey(open.doingKind, open.doingId)) return true;
  const expectedKey = shape.expected ? `${shape.expected.kind}:${shape.expected.id}` : "";
  if (expectedKey !== targetKey(open.expectedKind, open.expectedId)) return true;
  return false;
}

/**
 * Effective privacy, resolved by walking area → (outcome) → project → action/deliverable/commitment,
 * and rule → occurrence (Decision "Private", P3). Returns the set of `kind:id` keys that are private —
 * `action`/`deliverable`/`commitment`/`step`/`journey` (a step or journey inherits its commitment's; a
 * sleep-anchored step has no commitment and is never private, since sleep itself is not privatizable).
 */
export async function resolveEffectivePrivacy(sql: TxSql, userId: string): Promise<Set<string>> {
  const [areas, outcomeRows, projects, actions, deliverables, commitments, rules, steps] = await Promise.all([
    sql<{ id: string; private: boolean }[]>`SELECT id, private FROM areas WHERE user_id=${userId}`,
    sql<{ id: string; area_id: string }[]>`
      SELECT o.id, o.area_id FROM outcomes o JOIN areas a ON a.id = o.area_id WHERE a.user_id=${userId}
    `,
    sql<{ id: string; outcome_id: string; private: boolean }[]>`
      SELECT p.id, p.outcome_id, p.private FROM projects p
      JOIN outcomes o ON o.id = p.outcome_id JOIN areas a ON a.id = o.area_id WHERE a.user_id=${userId}
    `,
    sql<{ id: string; project_id: string; private: boolean }[]>`
      SELECT ac.id, ac.project_id, ac.private FROM actions ac
      JOIN projects p ON p.id = ac.project_id
      JOIN outcomes o ON o.id = p.outcome_id JOIN areas a ON a.id = o.area_id WHERE a.user_id=${userId}
    `,
    sql<{ id: string; project_id: string; private: boolean }[]>`
      SELECT d.id, d.project_id, d.private FROM deliverables d
      JOIN projects p ON p.id = d.project_id
      JOIN outcomes o ON o.id = p.outcome_id JOIN areas a ON a.id = o.area_id WHERE a.user_id=${userId}
    `,
    sql<{ id: string; recurrence_rule_id: string | null; private: boolean }[]>`
      SELECT id, recurrence_rule_id, private FROM commitments WHERE user_id=${userId}
    `,
    sql<{ id: string; private: boolean }[]>`
      SELECT id, private FROM commitment_recurrence_rules WHERE user_id=${userId}
    `,
    sql<{ id: string; commitment_id: string | null }[]>`
      SELECT id, commitment_id FROM routine_steps WHERE user_id=${userId} AND anchor_type='commitment'
    `
  ]);
  const areaPrivate = new Map(areas.map((row) => [row.id, row.private]));
  const areaByOutcome = new Map(outcomeRows.map((row) => [row.id, row.area_id]));
  const projectEffective = new Map<string, boolean>();
  for (const project of projects) {
    const areaId = areaByOutcome.get(project.outcome_id);
    const areaPriv = areaId ? (areaPrivate.get(areaId) ?? false) : false;
    projectEffective.set(project.id, project.private || areaPriv);
  }
  const rulePrivate = new Map(rules.map((row) => [row.id, row.private]));
  const commitmentEffective = new Map<string, boolean>();
  for (const commitment of commitments) {
    const rulePriv = commitment.recurrence_rule_id ? (rulePrivate.get(commitment.recurrence_rule_id) ?? false) : false;
    commitmentEffective.set(commitment.id, commitment.private || rulePriv);
  }
  const result = new Set<string>();
  for (const action of actions) {
    if (action.private || (projectEffective.get(action.project_id) ?? false)) result.add(`action:${action.id}`);
  }
  for (const deliverable of deliverables) {
    if (deliverable.private || (projectEffective.get(deliverable.project_id) ?? false))
      result.add(`deliverable:${deliverable.id}`);
  }
  for (const [id, priv] of commitmentEffective) {
    if (priv) {
      result.add(`commitment:${id}`);
      result.add(`journey:${id}`);
    }
  }
  for (const step of steps) {
    if (step.commitment_id && commitmentEffective.get(step.commitment_id)) result.add(`step:${step.id}`);
  }
  return result;
}

/** Builds the judge's input from the current plan, the live session and the state read Now uses,
    plus check-ins since local midnight, arrival and underway. */
async function gatherJudgeInput(sql: TxSql, userId: string, now: Date, timeZone: string): Promise<JudgePulseInput> {
  const planRows = await sql<{ result: unknown }[]>`
    SELECT result FROM planning_runs WHERE user_id=${userId} AND superseded_at IS NULL
    ORDER BY calculated_at DESC LIMIT 1
  `;
  const parsed = planRows[0] ? planForecastResponseSchema.safeParse(planRows[0].result) : null;
  const plan: PlanForecastResponse | null = parsed?.success ? parsed.data : null;

  const directive: JudgeDirective | null = plan
    ? {
        kind: plan.currentDirective.kind,
        ...("targetId" in plan.currentDirective && plan.currentDirective.targetId
          ? { targetId: plan.currentDirective.targetId }
          : {}),
        ...("title" in plan.currentDirective && plan.currentDirective.title
          ? { title: plan.currentDirective.title }
          : {})
      }
    : null;
  const dayPlanBlocks: JudgeDayPlanBlock[] = (plan?.dayPlan?.blocks ?? []).map((block) => ({
    kind: block.kind,
    targetId: block.targetId,
    title: block.title,
    startsAt: block.startsAt,
    endsAt: block.endsAt
  }));

  const commitmentTimelines = plan?.derivedState.commitmentTimelines ?? [];
  const commitmentRows = await sql<
    { id: string; title: string; location_id: string | null; freed_from: Date | null }[]
  >`
    SELECT id, title, location_id, freed_from FROM commitments WHERE user_id=${userId}
  `;
  const commitmentFreedFromById = new Map(commitmentRows.map((row) => [row.id, row.freed_from]));
  const commitmentTitleById = new Map(commitmentRows.map((row) => [row.id, row.title]));
  const commitmentLocationById = new Map(commitmentRows.map((row) => [row.id, row.location_id]));

  const nowMs = now.getTime();
  const protectedInForce: PulseTarget[] = [];

  const routineStepRows = await sql<
    { id: string; title: string; status: string; scheduled_start_at: Date | null; scheduled_end_at: Date | null }[]
  >`
    SELECT id, title, status, scheduled_start_at, scheduled_end_at FROM routine_steps
    WHERE user_id=${userId} AND status NOT IN ('completed','skipped','cancelled')
      AND scheduled_start_at IS NOT NULL AND scheduled_end_at IS NOT NULL
      AND scheduled_start_at <= ${now} AND scheduled_end_at > ${now}
  `;
  for (const step of routineStepRows) {
    protectedInForce.push({ kind: "step", id: step.id, title: step.title });
  }

  for (const timeline of commitmentTimelines) {
    const startsAt = new Date(timeline.setupStartsAt).getTime();
    const endsAt = new Date(timeline.freeAt).getTime();
    // "I'm free": the person released the rest of this occurrence, so it is no longer the plan and doing
    // the recommended task is on plan. Setup before the start and the transition after the effective
    // end still count (`commitmentFreedAt` is true only between the two).
    const freed = commitmentFreedAt({
      now,
      freedFrom: commitmentFreedFromById.get(timeline.id) ?? null,
      effectiveEndsAt: timeline.effectiveEndsAt
    });
    if (startsAt <= nowMs && nowMs < endsAt && !freed) {
      protectedInForce.push({
        kind: "commitment",
        id: timeline.id,
        title: commitmentTitleById.get(timeline.id) ?? ""
      });
    }
  }

  const sleepRows = await sql<
    {
      id: string;
      status: string;
      planned_start_at: Date;
      planned_wake_at: Date;
      actual_start_at: Date | null;
      actual_wake_at: Date | null;
    }[]
  >`
    SELECT id, status, planned_start_at, planned_wake_at, actual_start_at, actual_wake_at
    FROM sleep_plans WHERE user_id=${userId}
      AND ((status='planned' AND planned_start_at <= ${now} AND planned_wake_at > ${now})
        OR (status='sleeping' AND planned_wake_at + make_interval(mins => ${SLEEPING_PAST_WAKE_CAP_MINUTES}) > ${now})
        OR (status='completed' AND actual_start_at IS NOT NULL AND actual_wake_at IS NOT NULL
            AND actual_start_at <= ${now} AND actual_wake_at > ${now}))
    ORDER BY planned_start_at DESC LIMIT 1
  `;
  const activeSleep = sleepRows[0];
  if (activeSleep) protectedInForce.push({ kind: "sleep", id: activeSleep.id, title: "Sleep" });

  // The judge is the single place the sleep/session precedence lives (Decision "Sleep"): the recorder
  // only classifies which of the three sleep states covers `now`, and hands that — not a folded
  // boolean — to `judgePulse`, which is the one place that decides whether a running session yields to
  // it.
  let sleepState: "sleeping" | "planned" | "awake" = "awake";
  if (activeSleep) {
    if (activeSleep.status === "sleeping") {
      sleepState = "sleeping";
    } else if (
      activeSleep.status === "completed" &&
      activeSleep.actual_start_at &&
      activeSleep.actual_wake_at &&
      activeSleep.actual_start_at.getTime() <= nowMs &&
      nowMs < activeSleep.actual_wake_at.getTime()
    ) {
      // A completed night still spanning `now` reads exactly like a live `sleeping` one.
      sleepState = "sleeping";
    } else if (activeSleep.status === "planned") {
      sleepState = "planned";
    }
  }

  // Session — mirrors `now-activity.ts`'s own `isSessionActive`, plus the frozen `plan_sanction`.
  const sessionRows = await sql<
    {
      target_type: string;
      target_id: string | null;
      action_id: string;
      target_title: string | null;
      started_at: Date;
      plan_sanction: string | null;
      sanction_until: Date | null;
    }[]
  >`
    SELECT target_type, target_id, action_id, target_title, started_at, plan_sanction, sanction_until
    FROM sessions WHERE user_id=${userId} AND status IN ('running','paused') LIMIT 1
  `;
  const sessionRow = sessionRows[0];
  const sessionKind = sessionRow ? SESSION_TARGET_KIND[sessionRow.target_type] : undefined;
  const session: JudgePulseInput["session"] =
    sessionRow && sessionKind
      ? {
          target: {
            kind: sessionKind,
            id: sessionRow.target_id ?? sessionRow.action_id,
            title: sessionRow.target_title ?? ""
          },
          sanction: (sessionRow.plan_sanction as SessionSanction | null) ?? null,
          sanctionedUntil: sessionRow.sanction_until,
          startedAt: sessionRow.started_at
        }
      : null;

  // Check-ins since local midnight.
  const midnight = localMidnightUtc(now, timeZone);
  const checkInRows = await sql<
    {
      directive_kind: string;
      directive_target_id: string | null;
      directive_title: string;
      slot_at: Date;
      status: string;
      answered_at: Date | null;
    }[]
  >`
    SELECT directive_kind, directive_target_id, directive_title, slot_at, status, answered_at
    FROM check_in WHERE user_id=${userId} AND slot_at >= ${midnight} AND status <> 'superseded'
  `;
  const checkIns: JudgeCheckIn[] = [];
  for (const row of checkInRows) {
    const kind = CHECK_IN_TARGET_KIND[row.directive_kind];
    if (!kind || !row.directive_target_id) continue;
    if (row.status !== "on_track" && row.status !== "deviated" && row.status !== "unknown") continue;
    checkIns.push({
      target: { kind, id: row.directive_target_id, title: row.directive_title },
      slotAt: row.slot_at,
      status: row.status,
      answeredAt: row.answered_at
    });
  }

  // Arrival: a fresh location assertion matching an in-force commitment's own place.
  const situationRows = await sql<{ location_id: string | null; location_set_at: Date | null }[]>`
    SELECT (current_situation->>'locationId') AS location_id,
           (current_situation->>'locationSetAt')::timestamptz AS location_set_at
    FROM user_preferences WHERE user_id=${userId}
  `;
  const locationId = situationRows[0]?.location_id ?? null;
  const locationSetAt = situationRows[0]?.location_set_at ?? null;
  let arrival: JudgePulseInput["arrival"] = null;
  const inForceCommitment = protectedInForce.find((target) => target.kind === "commitment");
  if (inForceCommitment && locationId && locationSetAt) {
    const commitmentLocation = commitmentLocationById.get(inForceCommitment.id);
    if (commitmentLocation && commitmentLocation === locationId) {
      arrival = { target: inForceCommitment, at: locationSetAt };
    }
  }

  // Underway: `currentSituation.underway`, a direct "on my way" assertion for a commitment's journey.
  const underwayRows = await sql<{ commitment_id: string | null; departed_at: Date | null }[]>`
    SELECT (current_situation->'underway'->>'commitmentId') AS commitment_id,
           (current_situation->'underway'->>'departedAt')::timestamptz AS departed_at
    FROM user_preferences WHERE user_id=${userId}
  `;
  const underwayCommitmentId = underwayRows[0]?.commitment_id ?? null;
  const underwayDepartedAt = underwayRows[0]?.departed_at ?? null;
  const underway =
    underwayCommitmentId && underwayDepartedAt
      ? {
          target: {
            kind: "journey" as const,
            id: underwayCommitmentId,
            title: commitmentTitleById.get(underwayCommitmentId) ?? ""
          },
          at: underwayDepartedAt
        }
      : null;

  const privateTargets = await resolveEffectivePrivacy(sql, userId);

  const input: JudgePulseInput = {
    now,
    directive,
    dayPlanBlocks,
    protectedInForce,
    session,
    checkIns,
    arrival,
    underway,
    sleep: { state: sleepState },
    privateTargets
  };
  return input;
}

/**
 * Repaints the contiguous run of closed `off`/`unconfirmed` segments expecting `target` to
 * `on`/`confirmed` — Decision "Handover back-fill" (Q3). Walks backward one segment at a time, starting
 * from `closedAt` (the instant this same tick just closed the previously open segment, which itself is
 * repainted first when it was expecting `target` too — the confirmation `C` can fall anywhere inside
 * that final segment's span, and this module never splits a segment, so the whole thing is repainted
 * rather than only its tail), so a segment that fails the test (a different expectation, a `deviated`
 * lapse, an unsanctioned gap) stops the repaint rather than a single query silently repainting past it.
 */
async function backfillUnconfirmedRun(
  sql: TxSql,
  userId: string,
  target: PulseTarget,
  closedAt: Date,
  source: ContactSource | null
): Promise<void> {
  const rows = await sql<
    {
      id: string;
      started_at: Date;
      ended_at: Date;
      state: string;
      reason: string | null;
      expected_kind: string | null;
      expected_id: string | null;
    }[]
  >`
    SELECT id, started_at, ended_at, state, reason, expected_kind, expected_id
    FROM pulse_segments WHERE user_id=${userId} AND ended_at IS NOT NULL AND ended_at <= ${closedAt}
    ORDER BY started_at DESC LIMIT 500
  `;
  let cursor = closedAt.getTime();
  const idsToRepaint: string[] = [];
  for (const row of rows) {
    if (row.ended_at.getTime() !== cursor) break;
    // `unknown` since the state machine; `off`/`unconfirmed` is the same time recorded before it.
    const matches =
      (row.state === "unknown" || row.state === "off") &&
      row.reason === "unconfirmed" &&
      row.expected_kind === target.kind &&
      row.expected_id === target.id;
    if (!matches) break;
    idsToRepaint.push(row.id);
    cursor = row.started_at.getTime();
  }
  if (idsToRepaint.length === 0) return;
  await sql`
    UPDATE pulse_segments SET state='on', reason='confirmed', source=${source}, repainted_at=${new Date()}
    WHERE id = ANY(${idsToRepaint})
  `;
}

export type PulseRecorderOutcome =
  { status: "recorded"; judgement: PulseJudgement; result: PulseMachineResult } | { status: "skipped"; reason: string };

/** Command types (the `writes` receipt header) that record a state fact: contact, whoever made it. Agent plan
    edits (adding actions, moving commitments) are deliberately not here (the pulse on plan design note,
    "Transitions"). `save_entity` writes carry their entity type as the command type. */
const CONTACT_COMMAND_TYPES = [
  "answer_check_in",
  "answer_check_ins",
  "voluntary_check_in",
  "start",
  "select_alternative",
  "correct_start",
  "pause",
  "resume",
  "continue",
  "finish",
  "block",
  "did_not_start",
  "start_activity",
  "switch_deliverable_step",
  "pause_activity",
  "resume_activity",
  "finish_activity",
  "settle_catch_up",
  // Location and energy, and the sleep log. A settings save counts only when it records the wake
  // (`write_rows.evidence.wake`, below): an agent's plan-preference edit is not contact.
  "current_availability",
  "sleep_log_entry",
  // A recorded disruption is a person or agent telling the system what he is doing.
  "record_disruption"
];

/** How long a night still `sleeping` past its planned wake reads as asleep (no wake recorded). */
const SLEEPING_PAST_WAKE_CAP_MINUTES = 3 * 60;

/** How far back the first contact lookup reaches when the machine has no memory of one. */
const FIRST_CONTACT_LOOKBACK_MS = 24 * 60 * 60_000;
/** How far back an unknown that began without memory looks for prompts. */
const FIRST_PROMPT_LOOKBACK_MS = 3 * 60 * 60_000;
/** How far back a silent commitment or sleep night can still matter (a window ended this long ago is the
    most recent one the machine's 60 minute grace needs). */
const SILENCE_LOOKBACK_MS = 3 * 24 * 60 * 60_000;

interface PulseStateMemoryRow {
  last_evaluated_at: Date | null;
  last_contact_at: Date | null;
  last_contact_source: string | null;
  last_confirmed_at: Date | null;
  confirmed_by: string | null;
  unknown_since: Date | null;
  unknown_minutes: number | string;
  entered_lapsed_at: Date | null;
  reentered_at: Date | null;
  reentered_by: string | null;
}

function asContactSource(value: string | null): ContactSource | null {
  return value === "person" || value === "agent" || value === "schedule" ? value : null;
}

/** The machine's memory from the open segment (state, reason, since) and `pulse_state`; null for a user the
    recorder has never evaluated. */
function memoryFrom(
  open: OpenSegmentRow | null,
  row: PulseStateMemoryRow | undefined,
  now: Date,
  disruption: UsableDisruption | null
): PulseMachineMemory | null {
  if (!open) return null;
  const state = (["on", "unknown", "off", "free", "asleep"] as const).find((value) => value === open.state);
  if (!state) return null;
  const lastContactSource = asContactSource(row?.last_contact_source ?? null);
  const confirmedBy = row?.confirmed_by === "agent" ? "agent" : row?.confirmed_by === "person" ? "person" : null;
  return {
    state,
    offReason: state === "off" && open.reason === "lapsed" ? "lapsed" : null,
    onReason:
      state === "on" &&
      (open.reason === "confirmed" ||
        open.reason === "scheduled" ||
        open.reason === "reentered" ||
        open.reason === "disrupted")
        ? open.reason
        : state === "on"
          ? "confirmed"
          : null,
    since: open.startedAt,
    lastConfirmedAt: row?.last_confirmed_at ?? null,
    confirmedBy,
    lastContact:
      row?.last_contact_at && lastContactSource ? { at: row.last_contact_at, source: lastContactSource } : null,
    unknownSince: state === "unknown" ? (row?.unknown_since ?? open.startedAt) : null,
    unknownMinutes: state === "unknown" ? Number(row?.unknown_minutes ?? 0) : 0,
    // What held `on/disrupted`, so the machine can tell when it ran out (`unknown` from its `until`, not a lapse).
    disruption: state === "on" && open.reason === "disrupted" ? disruption : null,
    advancedAt: row?.last_evaluated_at ?? now
  };
}

interface DisruptionRow {
  id: string;
  doing: string;
  until: Date;
  location_id: string;
  contexts: string[];
  exclusive: boolean;
  created_at: Date;
}

/** The disruption in force (newest not ended), as the machine wants it. `until` may be past: the machine decides. */
async function readDisruption(tx: TxSql, userId: string): Promise<DisruptionRow | null> {
  const rows = await tx<DisruptionRow[]>`
    SELECT id, doing, until, location_id, contexts, exclusive, created_at FROM pulse_disruptions
    WHERE user_id=${userId} AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1
  `;
  return rows[0] ?? null;
}

function usableDisruption(row: DisruptionRow | null): UsableDisruption | null {
  return row
    ? {
        doing: row.doing,
        until: row.until,
        locationId: row.location_id,
        contexts: Array.isArray(row.contexts) ? row.contexts : [],
        exclusive: row.exclusive
      }
    : null;
}

/** The expected-silence window for `now`: silent commitments (a work shift) and the sleep night. The night is
    chosen by its effective start (the actual start of a night under way), and tonight's night is used whenever
    he is asleep or a sleep session is open, even when he went to bed before the planned start. */
async function resolveSilence(
  tx: TxSql,
  userId: string,
  now: Date,
  extraMinutes: number
): Promise<ExpectedSilenceWindow | null> {
  const since = new Date(now.getTime() - SILENCE_LOOKBACK_MS);
  const commitmentRows = await tx<{ starts_at: Date; ends_at: Date; prompt_policy: string }[]>`
    SELECT starts_at, ends_at, prompt_policy FROM commitments
    WHERE user_id=${userId} AND status <> 'cancelled' AND prompt_policy='silent'
      AND starts_at <= ${now} AND ends_at > ${since}
      AND (freed_from IS NULL OR freed_from > ${now})
  `;
  const sleepRows = await tx<
    {
      status: string;
      planned_start_at: Date;
      planned_wake_at: Date;
      actual_start_at: Date | null;
      actual_wake_at: Date | null;
      under_way: boolean;
    }[]
  >`
    SELECT p.status, p.planned_start_at, p.planned_wake_at, p.actual_start_at, p.actual_wake_at,
           (p.status = 'sleeping' OR EXISTS (
             SELECT 1 FROM sessions s
             WHERE s.user_id = p.user_id AND s.target_type = 'sleep' AND s.status IN ('running','paused')
               AND s.target_id::text = p.id::text
           )) AS under_way
    FROM sleep_plans p
    WHERE p.user_id=${userId} AND p.status <> 'cancelled'
      AND (p.planned_start_at <= ${now} OR p.status = 'sleeping' OR EXISTS (
        SELECT 1 FROM sessions s
        WHERE s.user_id = p.user_id AND s.target_type = 'sleep' AND s.status IN ('running','paused')
          AND s.target_id::text = p.id::text
      ))
    ORDER BY CASE WHEN p.actual_start_at IS NOT NULL AND p.status IN ('sleeping','completed')
                  THEN p.actual_start_at ELSE p.planned_start_at END DESC
    LIMIT 1
  `;
  const night = sleepRows[0];
  const actual = night?.status === "completed" && night.actual_start_at && night.actual_wake_at;
  let sleepNight: { startsAt: Date; endsAt: Date } | null = null;
  if (night) {
    const effectiveStart =
      night.actual_start_at && (night.status === "sleeping" || night.status === "completed")
        ? night.actual_start_at
        : night.planned_start_at;
    // A night under way started no later than now, whatever its planned start says.
    const startsAt =
      night.under_way && effectiveStart.getTime() > now.getTime() ? new Date(now.getTime() - 1) : effectiveStart;
    // A night still `sleeping` past its planned wake has no wake recorded yet: it stays asleep until the cap, after
    // which the stale-wake need asks (and the pulse reads unknown, never an instant lapse).
    sleepNight = {
      startsAt,
      endsAt: actual
        ? night.actual_wake_at!
        : night.status === "sleeping"
          ? new Date(night.planned_wake_at.getTime() + SLEEPING_PAST_WAKE_CAP_MINUTES * 60_000)
          : night.planned_wake_at
    };
  }
  return resolveExpectedSilence({
    commitments: commitmentRows.map((row) => ({
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      promptPolicy: row.prompt_policy
    })),
    sleepNight,
    now,
    extraMinutes
  });
}

/** The check-in allowance of the commitment in force (its own, else its rule's, else the default); 0 with none. */
async function resolveExtraMinutes(tx: TxSql, userId: string, input: JudgePulseInput): Promise<number> {
  const inForce = input.protectedInForce.find((target) => target.kind === "commitment");
  if (!inForce) return 0;
  const rows = await tx<{ own: number | null; rule: number | null }[]>`
    SELECT c.check_in_extra_minutes AS own, r.check_in_extra_minutes AS rule
    FROM commitments c LEFT JOIN commitment_recurrence_rules r ON r.id = c.recurrence_rule_id
    WHERE c.id=${inForce.id} AND c.user_id=${userId}
  `;
  return resolveCheckInExtraMinutes({ checkInExtraMinutes: rows[0]?.own ?? rows[0]?.rule ?? null });
}

/** Hourly cadence when a session is open or the commitment in force is `reduced`, else base (`cadenceFor`). */
const BASE_CADENCE_MINUTES = 20;
const HOURLY_CADENCE_MINUTES = 60;

/**
 * What the machine needs to tell "no confirmation yet" from "a missed one": whether a prompt for the current
 * target timed out, whether the open session is stale (`resolveFreshness`'s rule), the cadence, and when the
 * current block started.
 */
async function readMachineEvidence(
  tx: TxSql,
  userId: string,
  input: JudgePulseInput,
  judgement: PulseJudgement,
  now: Date
): Promise<{
  promptTimedOut: boolean;
  sessionStale: boolean;
  cadenceMinutes: number;
  checkInTimeoutMinutes: number;
  blockStartedAt: Date | null;
}> {
  const target = judgement.expected ?? judgement.doing;
  const latest = target
    ? input.checkIns
        .filter((c) => c.target.kind === target.kind && c.target.id === target.id)
        .sort((a, b) => b.slotAt.getTime() - a.slotAt.getTime())[0]
    : undefined;
  const promptTimedOut = latest?.status === "unknown";

  const sessionRows = await tx<
    {
      id: string;
      target_type: string;
      status: string;
      planned_end_at: Date;
      planned_minutes: number;
      paused_remaining_seconds: number | null;
    }[]
  >`
    SELECT id, target_type, status, planned_end_at, planned_minutes, paused_remaining_seconds
    FROM sessions WHERE user_id=${userId} AND status IN ('running','paused','awaiting_feedback') LIMIT 1
  `;
  const row = sessionRows[0];
  let sessionStale = false;
  if (row) {
    const activeSession = {
      id: row.id,
      targetType: row.target_type,
      status: row.status === "awaiting_feedback" ? "feedback" : row.status,
      plannedEndAt: row.planned_end_at.toISOString(),
      plannedMinutes: row.planned_minutes,
      ...(row.paused_remaining_seconds !== null ? { pausedRemainingSeconds: row.paused_remaining_seconds } : {})
    } as unknown as NonNullable<PortalStateContract["activeSession"]>;
    sessionStale = resolveFreshness(
      {
        settings: { maxAwakeHours: 24 },
        activeSession,
        currentSituation: { locationId: null }
      },
      now
    ).session.stale;
  }

  const inForce = input.protectedInForce.find((t) => t.kind === "commitment");
  let reduced = false;
  let commitmentStart: Date | null = null;
  if (inForce) {
    const c = await tx<{ prompt_policy: string; starts_at: Date }[]>`
      SELECT prompt_policy, starts_at FROM commitments WHERE id=${inForce.id} AND user_id=${userId}
    `;
    reduced = c[0]?.prompt_policy === "reduced";
    commitmentStart = c[0]?.starts_at ?? null;
  }
  const inForceStep = input.protectedInForce.find((t) => t.kind === "step");
  if (!commitmentStart && inForceStep) {
    const st = await tx<{ scheduled_start_at: Date | null }[]>`
      SELECT scheduled_start_at FROM routine_steps WHERE id=${inForceStep.id} AND user_id=${userId}
    `;
    commitmentStart = st[0]?.scheduled_start_at ?? null;
  }
  const nowMs = now.getTime();
  const block = target
    ? input.dayPlanBlocks.find(
        (b) =>
          b.targetId === target.id && new Date(b.startsAt).getTime() <= nowMs && nowMs < new Date(b.endsAt).getTime()
      )
    : undefined;
  const blockStartedAt = input.session?.startedAt ?? (block ? new Date(block.startsAt) : null) ?? commitmentStart;
  return {
    promptTimedOut,
    sessionStale,
    cadenceMinutes: row || reduced ? HOURLY_CADENCE_MINUTES : BASE_CADENCE_MINUTES,
    checkInTimeoutMinutes: DEFAULT_CHECK_IN_TIMEOUT_MINUTES,
    blockStartedAt
  };
}

/** The latest person or agent write of a state fact after `after`, or a check-in answered after it. */
async function readLatestContact(tx: TxSql, userId: string, after: Date, now: Date): Promise<ContactEvent | null> {
  const writeRows = await tx<{ created_at: Date; actor: string | null }[]>`
    SELECT w.created_at, w.actor FROM writes w
    WHERE w.user_id=${userId}
      AND (
        w.command_type = ANY(${CONTACT_COMMAND_TYPES})
        OR (w.command_type = 'settings' AND EXISTS (
          SELECT 1 FROM write_rows r WHERE r.write_id = w.id AND r.evidence->>'wake' = 'true'
        ))
      )
      AND w.created_at > ${after} AND w.created_at <= ${now}
      AND (w.actor IS NULL OR w.actor <> 'system')
    ORDER BY w.created_at DESC LIMIT 1
  `;
  const answerRows = await tx<{ answered_at: Date }[]>`
    SELECT answered_at FROM check_in
    WHERE user_id=${userId} AND answered_at IS NOT NULL AND answered_at > ${after} AND answered_at <= ${now}
    ORDER BY answered_at DESC LIMIT 1
  `;
  const write = writeRows[0]
    ? {
        at: writeRows[0].created_at,
        source: (writeRows[0].actor === null || writeRows[0].actor === "human" ? "person" : "agent") as ContactSource
      }
    : null;
  const answer = answerRows[0] ? { at: answerRows[0].answered_at, source: "person" as ContactSource } : null;
  if (write && answer) return answer.at.getTime() > write.at.getTime() ? answer : write;
  return write ?? answer;
}

/**
 * Runs one recorder pass for `userId`: gathers the judge's input, judges, advances the state machine
 * (`advancePulse`: contact, expected silence, the per-commitment allowance) and writes `pulse_segments`
 * (with the outage-gap and back-fill rules) and `pulse_state`. Serialised per user with an advisory
 * lock, since both the worker's 60s tick and the debounced `state_changed` subscriber can call this —
 * whichever wins the lock writes the one segment; the other sees its own write already reflected.
 */
export async function runPulseRecorderTick(sql: PoolSql, nowOverride?: Date): Promise<PulseRecorderOutcome> {
  return sql.begin(async (tx) => {
    const userId = await ensureUser(tx);
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`pulse_recorder:${userId}`}, 0))`;
    // Taken after the lock, so a waiter never evaluates at a moment earlier than the winner's write.
    let now = nowOverride ?? new Date();

    const userRows = await tx<{ timezone: string }[]>`SELECT timezone FROM users WHERE id=${userId}`;
    const timeZone = userRows[0]?.timezone ?? DEFAULT_TIMEZONE;

    const stateRows = await tx<PulseStateMemoryRow[]>`
      SELECT last_evaluated_at, last_contact_at, last_contact_source, last_confirmed_at, confirmed_by,
             unknown_since, unknown_minutes, entered_lapsed_at, reentered_at, reentered_by
      FROM pulse_state WHERE user_id=${userId}
    `;
    const stateRow = stateRows[0];
    const lastEvaluatedAt = stateRow?.last_evaluated_at ?? null;

    const openRows = await tx<
      {
        id: string;
        started_at: Date;
        state: string;
        reason: string | null;
        doing_kind: string | null;
        doing_id: string | null;
        doing_title: string | null;
        expected_kind: string | null;
        expected_id: string | null;
        private: boolean;
      }[]
    >`
      SELECT id, started_at, state, reason, doing_kind, doing_id, doing_title, expected_kind, expected_id, private
      FROM pulse_segments WHERE user_id=${userId} AND ended_at IS NULL LIMIT 1
    `;
    let open: OpenSegmentRow | null = openRows[0]
      ? {
          id: openRows[0].id,
          startedAt: openRows[0].started_at,
          state: openRows[0].state,
          reason: openRows[0].reason,
          doingKind: openRows[0].doing_kind,
          doingId: openRows[0].doing_id,
          doingTitle: openRows[0].doing_title,
          expectedKind: openRows[0].expected_kind,
          expectedId: openRows[0].expected_id,
          private: openRows[0].private
        }
      : null;

    // Never close a segment before it started (an explicit `now` older than the open segment).
    if (open && now.getTime() < open.startedAt.getTime()) now = open.startedAt;

    // The machine's memory is read before an outage gap drops the open segment: a lapse must survive an
    // outage, and the time the recorder was down is not time the person was unknown (the clock restarts
    // from `now`).
    const disruptionRow = await readDisruption(tx, userId);
    const disruption = usableDisruption(disruptionRow);
    const prev = memoryFrom(open, stateRow, now, disruption);
    const outage = !!lastEvaluatedAt && now.getTime() - lastEvaluatedAt.getTime() > GAP_THRESHOLD_MS;
    if (prev && outage) prev.advancedAt = now;

    // Outage gap: the recorder was silent over the threshold — close whatever was open at the last
    // moment it actually knew about, insert the gap, and evaluate the current judgement fresh.
    if (lastEvaluatedAt && outage) {
      if (open) {
        await tx`UPDATE pulse_segments SET ended_at=${lastEvaluatedAt} WHERE id=${open.id}`;
      }
      await tx`
        INSERT INTO pulse_segments (user_id, started_at, ended_at, state, private)
        VALUES (${userId}, ${lastEvaluatedAt}, ${now}, 'gap', false)
      `;
      open = null;
    }

    const input = await gatherJudgeInput(tx, userId, now, timeZone);
    const judgement = judgePulse(input);

    const prefRows = await tx<
      {
        pulse_unknown_to_off_minutes: number | null;
        pulse_further_prompts: number | null;
        pulse_unknown_hard_off_minutes: number | null;
      }[]
    >`
      SELECT pulse_unknown_to_off_minutes, pulse_further_prompts, pulse_unknown_hard_off_minutes
      FROM user_preferences WHERE user_id=${userId}
    `;
    const thresholds = {
      ...(prefRows[0]?.pulse_unknown_to_off_minutes != null
        ? { unknownToOffMinutes: prefRows[0].pulse_unknown_to_off_minutes }
        : {}),
      ...(prefRows[0]?.pulse_further_prompts != null ? { furtherPrompts: prefRows[0].pulse_further_prompts } : {}),
      ...(prefRows[0]?.pulse_unknown_hard_off_minutes != null
        ? { unknownHardOffMinutes: prefRows[0].pulse_unknown_hard_off_minutes }
        : {})
    };

    const extraMinutes = await resolveExtraMinutes(tx, userId, input);
    const silence = await resolveSilence(tx, userId, now, extraMinutes);
    const contact = await readLatestContact(
      tx,
      userId,
      prev?.lastContact?.at ?? new Date(now.getTime() - FIRST_CONTACT_LOOKBACK_MS),
      now
    );
    const promptRows = await tx<{ prompted_at: Date }[]>`
      SELECT prompted_at FROM check_in
      WHERE user_id=${userId} AND prompted_at IS NOT NULL AND prompted_at > ${prev?.unknownSince ?? new Date(now.getTime() - FIRST_PROMPT_LOOKBACK_MS)}
        AND prompted_at <= ${now}
    `;
    const promptsSentAt = promptRows.map((row) => row.prompted_at);
    // A `reenter` applied since the last pass (`pulse-reentry.ts` stamps `pulse_state.reentered_at`).
    const reenteredAt = stateRow?.reentered_at ?? null;
    const reentered: ContactEvent | null =
      reenteredAt && reenteredAt.getTime() <= now.getTime()
        ? { at: reenteredAt, source: stateRow?.reentered_by === "agent" ? "agent" : "person" }
        : null;

    const result: PulseMachineResult = advancePulse(
      prev,
      judgement,
      {
        contact,
        reentered,
        disruption,
        promptsSentAt,
        ...(await readMachineEvidence(tx, userId, input, judgement, now))
      },
      silence,
      now,
      {
        thresholds,
        extraMinutes
      }
    );
    // A user the system has never heard from (no confirmation, no contact, ever) has nothing to time out
    // from: a brand-new user, a first deploy, a fresh sandbox. They stay `unknown` until the first
    // confirmation or contact rather than lapsing into a re-entry nobody can complete.
    const neverHeardFrom = !result.lastConfirmedAt && !result.lastContact && !prev?.lastConfirmedAt;
    if (neverHeardFrom && result.state === "off" && !(prev?.state === "off" && prev.offReason === "lapsed")) {
      result.state = "unknown";
      result.offReason = null;
      result.enteredLapsed = false;
      result.unknownSince = prev?.unknownSince ?? now;
    }
    const shape = segmentShape(result, judgement);

    // Back on plan by an answer or a session that came after the disruption was recorded: it is over. (A confirmation
    // that predates it, e.g. a stale check-in, does not end one just recorded.)
    if (
      disruptionRow &&
      result.state === "on" &&
      result.onReason === "confirmed" &&
      judgement.confirmedAt &&
      judgement.confirmedAt.getTime() > disruptionRow.created_at.getTime()
    ) {
      await tx`UPDATE pulse_disruptions SET ended_at=${now}, updated_at=now() WHERE id=${disruptionRow.id}`;
    }

    if (!open || shapeDiffersFromOpen(shape, open)) {
      if (open) {
        await tx`UPDATE pulse_segments SET ended_at=${now} WHERE id=${open.id}`;
      }
      await tx`
        INSERT INTO pulse_segments
          (user_id, started_at, ended_at, state, reason, doing_kind, doing_id, doing_title,
           expected_kind, expected_id, private, confirmed_at, source)
        VALUES (
          ${userId}, ${now}, NULL, ${shape.state}, ${shape.reason},
          ${shape.doing?.kind ?? null}, ${shape.doing?.id ?? null}, ${shape.doing?.title ?? null},
          ${shape.expected?.kind ?? null}, ${shape.expected?.id ?? null}, ${shape.private},
          ${shape.confirmedAt}, ${shape.source}
        )
      `;
      // The unknown segment closed: a pulse_unknown wake not yet sent is no longer true.
      if (open?.state === "unknown" && shape.state !== "unknown") {
        await cancelPendingUnknownWakes(tx, userId);
      }
      // Once per unknown segment (a change inside one does not reopen it), and not stacked on a wake already sent
      // or queued for the same silence in the last 30 minutes.
      if (shape.state === "unknown" && open?.state !== "unknown") {
        const recent = await tx`
          SELECT 1 FROM agent_wakes
          WHERE user_id = ${userId} AND created_at > ${new Date(now.getTime() - 30 * 60_000)} LIMIT 1`;
        if (recent.length === 0) {
          await enqueueAgentWake(tx, { userId, event: "pulse_unknown", targetId: now.toISOString(), now });
        }
      }
      if (shape.state === "on" && shape.reason === "confirmed" && shape.doing && judgement.confirmedAt) {
        await backfillUnconfirmedRun(tx, userId, shape.doing, now, shape.source);
      }
    }

    // Once per lapse: the instant the state moved into `off/lapsed`, for the "Back on plan?" push.
    const enteredLapsedAt = result.enteredLapsed ? now : (stateRow?.entered_lapsed_at ?? null);
    if (result.enteredLapsed) {
      await queueBackOnPlanPush(tx, userId, now);
      // Wakes the owner's agent to ask where they are.
      await enqueueAgentWake(tx, { userId, event: "pulse_lapsed", targetId: now.toISOString(), now });
    }
    const unansweredPrompts =
      result.state === "unknown" && result.unknownSince
        ? promptsSentAt.filter((at) => at.getTime() > result.unknownSince!.getTime()).length
        : 0;
    await tx`
      INSERT INTO pulse_state
        (user_id, last_evaluated_at, last_contact_at, last_contact_source, last_confirmed_at, confirmed_by,
         unknown_since, unknown_minutes, unanswered_prompts, silence_until, entered_lapsed_at)
      VALUES (
        ${userId}, ${now}, ${result.lastContact?.at ?? null}, ${result.lastContact?.source ?? null},
        ${result.lastConfirmedAt}, ${result.confirmedBy}, ${result.unknownSince}, ${result.unknownMinutes},
        ${unansweredPrompts}, ${result.silenceUntil}, ${enteredLapsedAt}
      )
      ON CONFLICT (user_id) DO UPDATE SET
        last_evaluated_at=${now}, last_contact_at=${result.lastContact?.at ?? null},
        last_contact_source=${result.lastContact?.source ?? null}, last_confirmed_at=${result.lastConfirmedAt},
        confirmed_by=${result.confirmedBy}, unknown_since=${result.unknownSince},
        unknown_minutes=${result.unknownMinutes}, unanswered_prompts=${unansweredPrompts},
        silence_until=${result.silenceUntil}, entered_lapsed_at=${enteredLapsedAt},
        reentered_at=CASE WHEN pulse_state.reentered_at = ${reenteredAt} THEN NULL ELSE pulse_state.reentered_at END,
        updated_at=CURRENT_TIMESTAMP
    `;
    return { status: "recorded", judgement, result };
  });
}
