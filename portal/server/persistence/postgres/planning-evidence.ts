import {
  planForecastResponseSchema,
  type AgentCall,
  type PlanForecastResponse,
  type RecalculateCommand
} from "@openrhen/contracts";
import { buildPlanForecastRequest, enqueuePlanForecastJob, lockPlanForecastPublication } from "@openrhen/database";
import { PLAN_FORECAST_GRACE_MINUTES } from "@/features/planning/planning-runtime";
import {
  changeLogActor,
  changeLogConfirmedBy,
  requestClaim,
  SYSTEM_ACTOR,
  type WriteClaim
} from "@/server/agent-actor";
import type { PortalState } from "@/state/portal-state";
import { CommandConflictError, InvalidCommandError } from "./command-errors";
import { ensureUser } from "./ensure-user";
import { claimCommandReceipt, commandRequestHash, hasCommandReceipt } from "./command-receipt";
import { readStateAfterCommit } from "./read-after-commit";
import { readPortalState } from "./state-read";
import type { PoolSql, Sql } from "./sql-pool";

async function persistPlanningEvidence(
  sql: Sql,
  userId: string,
  at: Date
): Promise<{ recommendationId: string; inputVersion: string }> {
  // The request builder never reads `state.planning` (the request schema drops it), so skip the engine result.
  const state = await readPortalState(sql, { planning: false });
  if (!state) throw new InvalidCommandError("Planning state is unavailable.");
  // Only work the engine ranks can be extended by continuing it. Sleep, routines and fixed
  // commitments are directives with a length of their own, so asking to extend one produces a
  // refusal about an action that was never involved. An allow-list keeps a target type added later
  // from silently joining the request.
  const continuable = state.activeSession?.targetType ?? "action";
  const continuation =
    state.activeSession?.status === "feedback" && (continuable === "action" || continuable === "deliverable")
      ? {
          // A deliverable session names the deliverable; an action session names its action or
          // occurrence. Read the field that means what is intended rather than the one that
          // currently happens to hold it.
          actionId:
            continuable === "deliverable"
              ? (state.activeSession.targetId ?? state.activeSession.actionId)
              : state.activeSession.actionId
          // No `requestedMinutes`: the request builder asks for this target's own minimum useful
          // session, floored at 15. Naming 15 here refused every deliverable whose minimum is longer,
          // because the engine will not return a continuation shorter than the work needs.
        }
      : undefined;
  const request = await buildPlanForecastRequest(state, at, continuation, sql, userId);
  await enqueuePlanForecastJob(sql, userId, request, "planning_state_changed");
  return { recommendationId: state.currentRecommendationId ?? request.requestId, inputVersion: request.inputVersion };
}

/** A write to plan input, recorded as one `write_rows` row. See `recordStateChange`. */
export interface StateChange {
  entityType: string;
  entityId?: string | null;
  operation: string;
  evidence?: Record<string, unknown>;
  commandId?: string | null;
  at: Date;
  /**
   * The stored row as it was before this write, for an agent's write (the design notes,
   * "Before-image for agent writes"). Left undefined by a writer that does not supply one; null means there was
   * no earlier row. Never pass email-derived content: `write_rows` is not purged.
   */
  before?: Record<string, unknown> | null;
  /** Set by a writer whose entity is derived from email, so no before-image is ever stored for it. */
  noBefore?: boolean;
}

/** Columns that change on every save and say nothing about what the agent changed. */
const BOOKKEEPING_COLUMNS = new Set(["id", "version", "updated_at"]);

/**
 * The before-image of an update: only the columns whose value differs between the stored row and the
 * row after the write, each at its earlier value (the design notes keeps this
 * cheap). A create has no earlier row, so its before-image is null.
 */
export function changedFieldsBefore(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (!before) return null;
  // The id and the version it had identify the row; everything else is only what the write changed.
  const changed: Record<string, unknown> = { id: before.id, version: before.version };
  for (const [column, value] of Object.entries(before)) {
    if (BOOKKEEPING_COLUMNS.has(column)) continue;
    if (JSON.stringify(value) !== JSON.stringify(after?.[column])) changed[column] = value;
  }
  return changed;
}

/**
 * The evidence and row shape for a `write_rows` insert: the caller's own evidence merged with the
 * job's `recommendationId`/`inputVersion`, and `command_id` normalised to `null` when absent. Pure and
 * exported so the merge can be unit tested without a database.
 */
export function buildChangeLogRow(
  change: StateChange,
  jobEvidence: { recommendationId: string; inputVersion: string },
  actor: string | null,
  claim?: WriteClaim
): {
  commandId: string | null;
  entityType: string;
  entityId: string | null;
  operation: string;
  actor: string | null;
  evidence: Record<string, unknown>;
} {
  // Only an agent's write carries a before-image; a person's and the system's store nothing extra. A
  // writer that cannot supply one says so, so the feed never implies every agent write can be reversed.
  const isAgent = actor !== null && actor !== SYSTEM_ACTOR;
  const beforeEvidence: Record<string, unknown> = !isAgent
    ? {}
    : change.noBefore || change.before === undefined
      ? { before: null, beforeMissing: true }
      : { before: change.before };
  // The basis an agent claimed and the person's words it quoted.
  // Only an agent's write carries them, and only when it supplied them. An email-derived entity keeps the
  // basis alone: the quote is mail text and `write_rows` is not purged.
  const claimEvidence: Record<string, unknown> = !isAgent
    ? {}
    : {
        ...(claim?.basis ? { basis: claim.basis } : {}),
        ...(claim?.evidence && !change.noBefore ? { statedEvidence: claim.evidence } : {})
      };
  return {
    commandId: change.commandId ?? null,
    entityType: change.entityType,
    entityId: change.entityId ?? null,
    operation: change.operation,
    actor,
    evidence: { ...change.evidence, ...beforeEvidence, ...claimEvidence, ...jobEvidence }
  };
}

/**
 * The one write path: every write to state the planning engine
 * reads calls this exactly once, after the transaction's last state write. It enqueues a
 * recalculation job built from fresh state, then inserts one `write_rows` row carrying the job's
 * `recommendationId`/`inputVersion` merged into the caller's own evidence. A `write_rows` row without
 * a job is never allowed (invariant 2): the two happen together, here, or not at all.
 */
export async function recordStateChange(
  tx: Sql,
  userId: string,
  change: StateChange
): Promise<Record<string, unknown>> {
  const jobEvidence = await persistPlanningEvidence(tx, userId, change.at);
  const confirmedBy = changeLogConfirmedBy();
  const row = buildChangeLogRow(
    confirmedBy ? { ...change, evidence: { ...change.evidence, confirmedBy } } : change,
    jobEvidence,
    changeLogActor(),
    requestClaim()
  );
  // A write with a command id already has its `writes` row (the command claimed it first). One without (a
  // location observation, a travel spend, an ingest job, a state replace) gets a row of its own, here.
  const writeId =
    row.commandId ??
    (
      await tx<
        { id: string }[]
      >`INSERT INTO writes (id, user_id, command_type, actor) VALUES (gen_random_uuid(), ${userId}, ${row.entityType}, ${row.actor}) RETURNING id`
    )[0]!.id;
  await tx`INSERT INTO write_rows (write_id, user_id, entity_type, entity_id, operation, evidence) VALUES (${writeId}, ${userId}, ${row.entityType}, ${row.entityId}, ${row.operation}, ${tx.json(row.evidence as never)})`;
  return row.evidence;
}

/**
 * How long a command waits for a plan publication in flight before giving up. A publish takes a
 * second or two; far longer than that means something is wrong, and a retryable refusal is better
 * than a Start that hangs.
 */
const PUBLICATION_LOCK_WAIT = "5s";

/**
 * Where a run stands against the clock: `current` inside its validity window, `grace` past the
 * boundary but inside the tolerance, `expired` beyond it. Pure, so the boundary is tested without a
 * database. The portal gates Start at the boundary itself (it can wait for the refresh); the server
 * is the more tolerant of the two so the handheld and the API keep working through a brief outage.
 */
export function planForecastStanding(validUntil: Date | string, at: Date): "current" | "grace" | "expired" {
  const staleFor = at.getTime() - new Date(validUntil).getTime();
  if (staleFor <= 0) return "current";
  return staleFor > PLAN_FORECAST_GRACE_MINUTES * 60_000 ? "expired" : "grace";
}

async function readCurrentPlanForecast(sql: Sql, userId: string): Promise<PlanForecastResponse | null> {
  const rows = await sql<
    { result: unknown }[]
  >`SELECT result FROM planning_runs WHERE user_id=${userId} AND superseded_at IS NULL ORDER BY calculated_at DESC LIMIT 1`;
  const parsed = rows[0] ? planForecastResponseSchema.safeParse(rows[0].result) : null;
  return parsed?.success ? parsed.data : null;
}

/**
 * Takes the per-user publication lock for a command that acts on the plan, waiting at most
 * `PUBLICATION_LOCK_WAIT` for a publish in flight. A command must take it before any row lock: the
 * worker's publish takes it first and then locks rows (the occurrences it upserts, and key-share locks
 * on actions and projects from its foreign keys), so a command holding row locks while it waits here
 * closes a cycle Postgres breaks by failing one side. The lock is re-entrant
 * within a transaction, so taking it early and again in `requireCurrentPlanForecast` is free. If it
 * is not free in time the refusal is a retryable conflict, never a claim that the plan is unavailable.
 */
export async function holdPlanForecastPublication(sql: Sql, userId: string): Promise<void> {
  const previous = (await sql<{ value: string }[]>`SELECT current_setting('lock_timeout') AS value`)[0]?.value ?? "0";
  await sql`SELECT set_config('lock_timeout', ${PUBLICATION_LOCK_WAIT}, true)`;
  try {
    await lockPlanForecastPublication(sql, userId);
  } catch (error) {
    if ((error as { code?: string }).code === "55P03")
      throw new CommandConflictError(
        "The plan is refreshing right now, so this write was not made. Wait a few seconds, then repeat the identical call (the same command-id, if it had one).",
        {
          nextCall: {
            tool: "rhen_status",
            arguments: {},
            note: "shows whether the plan has finished refreshing; once it has, repeat the identical call"
          }
        }
      );
    throw error;
  }
  await sql`SELECT set_config('lock_timeout', ${previous}, true)`;
}

/**
 * An expired-but-recent run still describes the user's plan; only the recalculation that would
 * refresh it is late. Blocking Start outright turned a brief worker outage into an inability to
 * work at all, so a run inside the grace period is accepted and the staleness is surfaced instead
 * (the status row, the banner and the handheld's `planFresh`).
 *
 * The run is read under the publication lock, current or not. Without it the worker could publish a
 * newer run between this read and the command's own writes, and the session would be sanctioned by a
 * plan that had already been replaced; with it the publish waits for the command, or the command sees
 * the new run and is judged against that. Callers that lock rows first take the lock themselves before
 * those rows (`holdPlanForecastPublication`).
 */
export async function requireCurrentPlanForecast(sql: Sql, userId: string, at: Date): Promise<PlanForecastResponse> {
  await holdPlanForecastPublication(sql, userId);
  const run = await readCurrentPlanForecast(sql, userId);
  if (!run)
    throw new InvalidCommandError(
      "No Plan and Forecast Engine result is available. Wait for the first recalculation before starting or continuing."
    );
  if (planForecastStanding(run.validUntil, at) === "expired")
    throw new InvalidCommandError(
      "The Plan and Forecast Engine result is more than two hours out of date. Wait for recalculation before starting or continuing."
    );
  return run;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * A tracked-commitment session is reported under one of two mutually exclusive recommendation keys —
 * `protectedCommitment` when the clock is held, `openAnchor` when you are at the commitment but the
 * hour is still your own (report on the engagement strip: the id lookup only ever checked
 * `protectedCommitment`, so "I'm engaged" against an open anchor was rejected every time). Both
 * publish the same shape, so one id/phase/duration check serves either key.
 */
function matchesTrackedCommitment(
  candidate: Record<string, unknown> | null,
  targetId: string,
  plannedMinutes: number,
  phase: "setup" | "travel" | "arrival" | "active" | "transition" | "return" | undefined
): boolean {
  if (!candidate || candidate.id !== targetId || candidate.phase !== phase) return false;
  // A run persisted before phase edges were published carries no `phaseStartsAt`/`phaseEndsAt`; fall
  // back to the id-and-phase check that predates this rather than refusing every open plan at once.
  if (typeof candidate.phaseStartsAt !== "string" || typeof candidate.phaseEndsAt !== "string") return true;
  // The active phase is the one exception to "track only this phase's own window" (d3f0b13): its
  // Start button (protected-commitment-panel.tsx) and the device API (device-now.ts,
  // commitmentPhaseRawMinutes) both deliberately request minutes through `protectedEndAt` — the
  // trailing transition buffer included — not `phaseEndsAt`. This bound has to widen the same way,
  // or every tap in that buffer's opening minutes is refused as "not present in the current Plan and
  // Forecast Engine result" even though the commitment is right there.
  const windowEnd =
    phase === "active" && typeof candidate.protectedEndAt === "string"
      ? candidate.protectedEndAt
      : candidate.phaseEndsAt;
  const phaseMinutes = Math.max(
    1,
    Math.round((new Date(windowEnd).getTime() - new Date(candidate.phaseStartsAt).getTime()) / 60_000)
  );
  return plannedMinutes <= phaseMinutes;
}

type CommitmentPhase = "setup" | "travel" | "arrival" | "active" | "transition" | "return";

/**
 * Names why `currentEngineResultIncludesActivity` refused a tracked commitment — the check folds four
 * causes together (not the commitment running now, no phase given, wrong phase, too many minutes), and
 * the person can only fix the one that applies. A commitment at a place that has not been arrived at
 * yet is never published as running, so it reads as the first cause and the message says so.
 */
export function explainCommitmentActivityRefusal(
  result: PlanForecastResponse,
  targetId: string,
  plannedMinutes: number,
  phase: CommitmentPhase | undefined
): string {
  const recommendation = asRecord(result.recommendation) ?? {};
  const candidates = [asRecord(recommendation.protectedCommitment), asRecord(recommendation.openAnchor)].filter(
    (candidate): candidate is Record<string, unknown> => candidate !== null && candidate.id === targetId
  );
  if (candidates.length === 0)
    return (
      "That commitment is not the one running now: the current plan is not tracking it, so there is nothing to start. " +
      "Start it from its own window, and if it is at a place, assert arrival first."
    );
  const inPhase = candidates.find((candidate) => candidate.phase === phase);
  if (!inPhase) {
    const current = String(candidates[0]!.phase);
    return phase === undefined
      ? `No phase was given, but this commitment is in its ${current} phase now; pass phase ${current}.`
      : `This commitment is in its ${current} phase now, not ${phase}; pass phase ${current}.`;
  }
  if (typeof inPhase.phaseStartsAt === "string" && typeof inPhase.phaseEndsAt === "string") {
    const windowEnd =
      phase === "active" && typeof inPhase.protectedEndAt === "string" ? inPhase.protectedEndAt : inPhase.phaseEndsAt;
    const phaseMinutes = Math.max(
      1,
      Math.round((new Date(windowEnd).getTime() - new Date(inPhase.phaseStartsAt).getTime()) / 60_000)
    );
    return `${plannedMinutes} minutes is longer than the ${phaseMinutes} that the ${phase} phase has; ask for ${phaseMinutes} or fewer.`;
  }
  return "That commitment is not on offer to start right now.";
}

/**
 * Why `continue` was refused: the engine allows exactly one figure (`continuation.recommendedMinutes`) and only when it
 * says the continuation is safe. The first case names that figure and the call to repeat with it; the second gives the
 * engine's reason and the call that closes the session instead.
 */
export function explainContinuationRefusal(
  continuation: Record<string, unknown> | null,
  requestedMinutes: number
): { message: string; nextCall: AgentCall; validValues?: Record<string, string[]> } {
  if (continuation?.safe === true && typeof continuation.recommendedMinutes === "number") {
    const allowed = continuation.recommendedMinutes;
    return {
      message:
        `The plan lets this session continue for exactly ${allowed} minutes, not ${requestedMinutes}. ` +
        (typeof continuation.reason === "string" ? `Why: ${continuation.reason} ` : "") +
        `Repeat the same rhen_session call with minutes ${allowed}.`,
      nextCall: {
        tool: "rhen_session",
        arguments: { subcommand: "continue", minutes: allowed },
        note: "the only figure the plan allows"
      },
      validValues: { minutes: [String(allowed)] }
    };
  }
  const reason =
    typeof continuation?.reason === "string"
      ? continuation.reason
      : "The current engine result does not permit that continuation.";
  return {
    message:
      `${reason} This session cannot be continued now. Record how it went with rhen_session finish ` +
      "(outcome completed, progress with remaining set to the minutes still to do, or unsure).",
    nextCall: {
      tool: "rhen_session",
      arguments: { subcommand: "finish" },
      note: "outcome completed, progress (with remaining) or unsure"
    }
  };
}

const ACTIVITY_LABEL = { routine_step: "routine step", sleep: "sleep plan", deliverable: "deliverable step" } as const;

/**
 * Names why `currentEngineResultIncludesActivity` refused a routine step, sleep plan or deliverable. For these the
 * minutes must equal the ones the plan gives the target (a routine step's durationMinutes, a sleep plan's
 * allowedMinutes, the directive's recommendedMinutes), so a start for the right target with other minutes is
 * answered with the minutes to send; a target the plan is not tracking now is answered with the call that shows what is.
 */
export function explainActivityRefusal(
  result: PlanForecastResponse,
  targetType: "routine_step" | "sleep" | "deliverable",
  targetId: string,
  plannedMinutes: number
): { message: string; nextCall: AgentCall; validValues?: Record<string, string[]> } {
  const label = ACTIVITY_LABEL[targetType];
  const statusCall: AgentCall = {
    tool: "rhen_status",
    arguments: {},
    note: "shows what the plan lets you start now, and for how many minutes"
  };
  const collection =
    targetType === "sleep"
      ? result.derivedState.sleepPlans
      : targetType === "routine_step"
        ? result.derivedState.routineSteps
        : [];
  const item = collection.find((entry) => asRecord(entry)?.id === targetId);
  const fromItem = asRecord(item)?.[targetType === "sleep" ? "allowedMinutes" : "durationMinutes"];
  const directive = result.currentDirective;
  const fromDirective =
    directive.kind === targetType && directive.targetId === targetId ? directive.recommendedMinutes : undefined;
  const planned = typeof fromItem === "number" ? fromItem : fromDirective;
  if (typeof planned === "number" && planned > 0)
    return {
      message:
        `The plan gives this ${label} ${planned} minutes, not ${plannedMinutes}: for a ${label}, minutes must equal ` +
        `the minutes the plan gives it. Repeat the same rhen_activity call with minutes ${planned}.`,
      nextCall: statusCall,
      validValues: { minutes: [String(planned)] }
    };
  const recommendation = asRecord(result.recommendation) ?? {};
  const holder = asRecord(recommendation.protectedCommitment);
  if (holder !== null && typeof holder.title === "string") {
    const until = typeof holder.protectedEndAt === "string" ? ` until ${holder.protectedEndAt}` : "";
    return {
      message:
        `The plan is not tracking that ${label} now because the commitment "${holder.title}" (id ${String(holder.id)}) holds ` +
        `this time${until}, so there is nothing to start. Nothing is wrong with the ${label} itself. A commitment keeps ` +
        "its protected block until it ends, even when its session was finished or the owner has said they are done early. " +
        "Do not retry this start. The options are: wait until the block ends; or, if the owner no longer wants the " +
        "commitment at all, rhen_cancel it (that cancels the whole commitment, not just today's block). Ask the owner which.",
      nextCall: statusCall
    };
  }
  return {
    message:
      `That ${label} is not present in the current Plan and Forecast Engine result: the plan is not tracking it now, ` +
      "so there is nothing to start.",
    nextCall: statusCall
  };
}

export function currentEngineResultIncludesActivity(
  result: PlanForecastResponse,
  targetType: "sleep" | "routine_step" | "fixed_commitment" | "deliverable",
  targetId: string,
  plannedMinutes: number,
  phase?: "setup" | "travel" | "arrival" | "active" | "transition" | "return"
): boolean {
  if (targetType === "fixed_commitment") {
    const recommendation = asRecord(result.recommendation) ?? {};
    return (
      matchesTrackedCommitment(asRecord(recommendation.protectedCommitment), targetId, plannedMinutes, phase) ||
      matchesTrackedCommitment(asRecord(recommendation.openAnchor), targetId, plannedMinutes, phase)
    );
  }
  if (
    result.currentDirective.kind === targetType &&
    result.currentDirective.targetId === targetId &&
    result.currentDirective.recommendedMinutes === plannedMinutes
  )
    return true;
  // "deliverable" has no collection of its own here: the directive-kind check above is authoritative
  // for it (unchanged from before — this fallback never matched a deliverable either, since it
  // fell through to the old `routineInstances` array, which never held one).
  const collection =
    targetType === "sleep"
      ? result.derivedState.sleepPlans
      : targetType === "routine_step"
        ? result.derivedState.routineSteps
        : [];
  return collection.some((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || item.id !== targetId) return false;
    if (targetType === "sleep") return item.allowedMinutes === plannedMinutes;
    return item.durationMinutes === plannedMinutes;
  });
}

/** A directive kind that directs nothing — see `judgePulse`'s own `FREE_DIRECTIVE_KINDS`. */
const FREE_DIRECTIVE_KINDS = new Set(["none", "boundary", "answer", "recovery"]);

/**
 * The pulse criteria and publish design note (Decision Q2, "Self-started session"): what sanctions
 * a session's target at the moment it starts, decided once and frozen onto `sessions.plan_sanction`.
 * Reused by both command files (`session-commands.ts` for an action, `activity-commands.ts` for a
 * step, commitment, sleep or deliverable session) so the same reading applies wherever a session can
 * start. Never called again once the session exists — a later replan must never change it.
 */
export function deriveSessionSanction(
  current: PlanForecastResponse,
  targetType: "action" | "sleep" | "routine_step" | "fixed_commitment" | "deliverable",
  targetId: string,
  at: Date,
  phase?: "setup" | "travel" | "arrival" | "active" | "transition" | "return"
): "directive" | "day_plan_block" | "free" | null {
  const directiveKind = targetType === "fixed_commitment" ? "commitment" : targetType;
  if (current.currentDirective.kind === directiveKind && current.currentDirective.targetId === targetId)
    return "directive";
  if (targetType === "fixed_commitment") {
    const recommendation = asRecord(current.recommendation) ?? {};
    const protectedCommitment = asRecord(recommendation.protectedCommitment);
    const openAnchor = asRecord(recommendation.openAnchor);
    if (
      (protectedCommitment && protectedCommitment.id === targetId && protectedCommitment.phase === phase) ||
      (openAnchor && openAnchor.id === targetId && openAnchor.phase === phase)
    )
      return "day_plan_block";
  }
  const collection =
    targetType === "sleep"
      ? current.derivedState.sleepPlans
      : targetType === "routine_step"
        ? current.derivedState.routineSteps
        : [];
  if (collection.some((item) => !!item && typeof item === "object" && !Array.isArray(item) && item.id === targetId))
    return "day_plan_block";
  const coveredByBlock = (current.dayPlan?.blocks ?? []).some(
    (block) =>
      block.kind !== "gap" &&
      block.kind !== "recovery" &&
      block.targetId === targetId &&
      new Date(block.startsAt).getTime() <= at.getTime() &&
      at.getTime() < new Date(block.endsAt).getTime()
  );
  if (coveredByBlock) return "day_plan_block";
  const protectedInForce = (current.dayPlan?.blocks ?? []).some(
    (block) =>
      (block.kind === "commitment" || block.kind === "sleep" || block.kind === "routine_step") &&
      new Date(block.startsAt).getTime() <= at.getTime() &&
      at.getTime() < new Date(block.endsAt).getTime()
  );
  const isFree = FREE_DIRECTIVE_KINDS.has(current.currentDirective.kind) && !protectedInForce;
  return isFree ? "free" : null;
}

export async function recalculate(sql: PoolSql, command: RecalculateCommand): Promise<PortalState> {
  const userId = await ensureUser(sql);
  const requestHash = commandRequestHash(command.type, command);
  if (await hasCommandReceipt(sql, { id: command.commandId, userId, commandType: command.type, requestHash }))
    return await readStateAfterCommit(sql);
  await sql.begin(async (tx) => {
    // The server's clock, never `command.now`: this instant becomes the request's `calculatedAt` and the
    // job's `stateCapturedAt`, and a browser whose clock runs behind would date the plan in the past and
    // order its failure before the run it should supersede. Taken here, with a connection in hand, not
    // before `begin`: a wait for the pool while another forecast lands would otherwise date the job
    // before the state it reads, and its valid result would be discarded as older than that run.
    const at = new Date();
    if (!(await claimCommandReceipt(tx, { id: command.commandId, userId, commandType: command.type, requestHash })))
      return;
    if (command.assertedConditions)
      await tx`UPDATE user_preferences SET asserted_conditions=${tx.json(command.assertedConditions as never)}, version=version+1, updated_at=CURRENT_TIMESTAMP WHERE user_id=${userId}`;
    await tx`UPDATE user_preferences SET current_horizon_end_at=${new Date(at.getTime() + 7 * 24 * 60 * 60_000)},updated_at=CURRENT_TIMESTAMP WHERE user_id=${userId}`;
    await recordStateChange(tx, userId, {
      entityType: "planning",
      operation: "recalculate",
      commandId: command.commandId,
      at
    });
  });
  return await readStateAfterCommit(sql);
}
