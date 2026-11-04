import { RECURRENCE_ENDED_REASON } from "@openrhen/contracts";
import { closeBudgetApplies } from "./close-budget";
import { recordStateChange } from "./planning-evidence";
import type { Sql } from "./sql-pool";
import { withClosedActor } from "./system-close";
import type { WriteSnapshot } from "./write-snapshot";

/**
 * Ending a recurrence rule closes its future occurrences instead of deleting them (archive-removals design section 7,
 * PR 7b), and setting the rule active again brings back exactly the ones that end closed.
 *
 * Provenance is the pair reason {@link RECURRENCE_ENDED_REASON} plus one shared `closed_batch`; `closed_by` is the
 * real closer (`person`, `agent:<name>`, or `system` for an import), so an agent cannot restore one occurrence of a
 * person's rule end without the proposal path. Occurrences already cancelled keep their own `closed_*`. The steps that
 * closed with them are recorded on one ledger row on the rule as `[step, commitment, from, version]` tuples, which is
 * what re-activation and a single-occurrence restore revive them from.
 */

/** The most step tuples one rule end records; beyond it a re-activation falls back to `pending`. */
export const RECURRENCE_END_STEP_CAP = 2000;

/** A routine step closed with an occurrence: its id, its commitment, the status it had, and the version the close left. */
export type EndedStepTuple = [stepId: string, commitmentId: string, from: string, version: number];

export interface RecurrenceEndOptions {
  /** The shared `closed_batch` (and the ledger row's batch). */
  batch: string;
  /** The write's snapshot when an agent is making it; the caller has already watched the rule's occurrences. */
  snap: WriteSnapshot | null;
  /** `person`, `agent:<name>[:confirmed]`; null for an import's end, which the trigger stamps `system`. */
  actor: string | null;
  /** The write's command id (an import: its batch id), so the ledger row shares its `writes` row. */
  commandId: string | null;
  via: "recurrence_end" | "import";
}

export interface RecurrenceEndResult {
  /** Occurrences closed. */
  rows: number;
  /** Steps closed with them. */
  steps: number;
}

/**
 * Closes the rule's future occurrences that are still open, with one shared batch, and cancels their pending and
 * blocked steps. A started step (`doing`, `completed`) stays as it is: its evidence is kept. Writes one `close` ledger
 * row on the rule when anything was closed; the brake counts it as 1, however many dates the rule had (the rule is the
 * thing that was closed and its dates come back when it is set active again).
 */
export async function closeFutureOccurrences(
  tx: Sql,
  userId: string,
  ruleId: string,
  options: RecurrenceEndOptions
): Promise<RecurrenceEndResult> {
  const occurrences = await tx<{ id: string; version: number }[]>`
    SELECT id, version FROM commitments
    WHERE user_id=${userId} AND recurrence_rule_id=${ruleId} AND starts_at>CURRENT_TIMESTAMP AND status<>'cancelled'
    ORDER BY starts_at, id
    FOR NO KEY UPDATE`;
  if (occurrences.length === 0) return { rows: 0, steps: 0 };
  const ids = occurrences.map((row) => row.id);
  await options.snap?.before("commitments", ids);
  await withClosedActor(tx, options.actor, async () => {
    await tx`UPDATE commitments SET status='cancelled', closed_batch=${options.batch}, closed_reason=${RECURRENCE_ENDED_REASON}, version=version+1, updated_at=CURRENT_TIMESTAMP WHERE id IN ${tx(ids)}`;
  });
  const steps = await tx<{ id: string; commitment_id: string; status: string; version: number }[]>`
    SELECT id, commitment_id, status, version FROM routine_steps
    WHERE commitment_id IN ${tx(ids)} AND status IN ('pending','blocked')
    ORDER BY commitment_id, sequence, id
    FOR NO KEY UPDATE`;
  const tuples: EndedStepTuple[] = steps.map((step) => [step.id, step.commitment_id, step.status, step.version + 1]);
  if (steps.length > 0) {
    await options.snap?.before(
      "routine_steps",
      steps.map((step) => step.id)
    );
    await tx`UPDATE routine_steps SET status='cancelled', version=version+1, updated_at=CURRENT_TIMESTAMP WHERE id IN ${tx(steps.map((step) => step.id))}`;
  }
  await recordStateChange(tx, userId, {
    entityType: "commitment_recurrence_rule",
    entityId: ruleId,
    operation: "close",
    commandId: options.commandId,
    noBefore: true,
    evidence: {
      do: "close",
      verb: "cancel",
      batch: options.batch,
      closed: 1,
      rows: ids.length,
      counted: closeBudgetApplies(),
      via: options.via,
      steps: tuples.slice(0, RECURRENCE_END_STEP_CAP),
      stepCount: tuples.length,
      ...(tuples.length > RECURRENCE_END_STEP_CAP ? { truncated: true } : {})
    },
    at: new Date()
  });
  return { rows: ids.length, steps: steps.length };
}

/** What the latest end of this rule recorded: its batch and step tuples (absent when the ledger row is gone). */
async function latestEnd(
  tx: Sql,
  userId: string,
  ruleId: string
): Promise<{ batch: string; steps: EndedStepTuple[] } | null> {
  const row = (
    await tx<{ evidence: { batch?: unknown; steps?: unknown } }[]>`
      SELECT evidence FROM write_rows
      WHERE user_id=${userId} AND entity_type='commitment_recurrence_rule' AND entity_id=${ruleId}
        AND operation='close' AND evidence->>'batch' IS NOT NULL
      ORDER BY created_at DESC, id DESC LIMIT 1`
  )[0];
  if (row && typeof row.evidence.batch === "string") {
    const steps = Array.isArray(row.evidence.steps) ? (row.evidence.steps as EndedStepTuple[]) : [];
    return { batch: row.evidence.batch, steps };
  }
  // No ledger row (purged, or an end from before the ledger): the batch the most recent matching close left.
  const found = (
    await tx<{ closed_batch: string }[]>`
      SELECT closed_batch FROM commitments
      WHERE user_id=${userId} AND recurrence_rule_id=${ruleId} AND status='cancelled'
        AND closed_reason=${RECURRENCE_ENDED_REASON} AND closed_batch IS NOT NULL
      ORDER BY closed_at DESC NULLS LAST LIMIT 1`
  )[0];
  return found ? { batch: found.closed_batch, steps: [] } : null;
}

/**
 * Setting an ended rule active again: the future occurrences closed by its latest end come back to the status they
 * had, and their cancelled steps to the status they were in (a blocked step returns blocked; the planner reconciles
 * it). Rows closed any other way (a person's or agent's own cancel, an earlier end) and past dates stay closed.
 */
export async function restoreEndedOccurrences(
  tx: Sql,
  userId: string,
  ruleId: string,
  options: { snap: WriteSnapshot | null; commandId: string | null }
): Promise<RecurrenceEndResult> {
  const end = await latestEnd(tx, userId, ruleId);
  if (!end) return { rows: 0, steps: 0 };
  const occurrences = await tx<{ id: string }[]>`
    SELECT id FROM commitments
    WHERE user_id=${userId} AND recurrence_rule_id=${ruleId} AND status='cancelled'
      AND closed_reason=${RECURRENCE_ENDED_REASON} AND closed_batch=${end.batch} AND starts_at>CURRENT_TIMESTAMP
    ORDER BY starts_at, id
    FOR NO KEY UPDATE`;
  if (occurrences.length === 0) return { rows: 0, steps: 0 };
  const ids = occurrences.map((row) => row.id);
  const restored = new Set(ids);
  await options.snap?.before("commitments", ids);
  await tx`UPDATE commitments SET status=COALESCE(closed_from_status,'confirmed'), version=version+1, updated_at=CURRENT_TIMESTAMP WHERE id IN ${tx(ids)}`;
  // The steps come back from the recorded tuples: only a step still cancelled at the version the end left it.
  let revived = 0;
  for (const [stepId, commitmentId, from, version] of end.steps) {
    if (!restored.has(commitmentId)) continue;
    await options.snap?.before("routine_steps", [stepId]);
    const done =
      await tx`UPDATE routine_steps SET status=${from}, version=version+1, updated_at=CURRENT_TIMESTAMP WHERE id=${stepId} AND status='cancelled' AND version=${version}`;
    revived += done.count;
  }
  // A step the tuples do not cover (past the cap, or changed since the end) falls back to pending.
  const rest = await tx<{ id: string }[]>`
    SELECT id FROM routine_steps WHERE commitment_id IN ${tx(ids)} AND status='cancelled' FOR NO KEY UPDATE`;
  if (rest.length > 0) {
    await options.snap?.before(
      "routine_steps",
      rest.map((step) => step.id)
    );
    await tx`UPDATE routine_steps SET status='pending', version=version+1, updated_at=CURRENT_TIMESTAMP WHERE id IN ${tx(rest.map((step) => step.id))}`;
    revived += rest.length;
  }
  await recordStateChange(tx, userId, {
    entityType: "commitment_recurrence_rule",
    entityId: ruleId,
    operation: "restore",
    commandId: options.commandId,
    noBefore: true,
    evidence: {
      do: "restore",
      verb: "cancel",
      batch: end.batch,
      rows: ids.length,
      steps: revived,
      via: "recurrence_reactivate"
    },
    at: new Date()
  });
  return { rows: ids.length, steps: revived };
}
