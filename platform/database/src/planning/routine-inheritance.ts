import type postgres from "postgres";
import { isCadenceStepEligibleToday, type CadenceGateRule } from "./cadence-step-gate.js";
import {
  planRoutineStepReconciliation,
  type CommitmentRoutineStepInput,
  type ExistingRoutineStepForPlan,
  type RoutineStepPlanOp,
  type RoutineStepReconciliationPlan
} from "@openrhen/contracts";

/**
 * Location-anchored routine inheritance for fixed commitments.
 *
 * A commitment's `routine_source` says where its preparation steps come from: the place default
 * ('inherit', via `location_id` → `condition_definitions.default_routine_preset_id`), a named preset
 * ('preset', via `routine_preset_id`), steps the user shaped by hand ('custom'), or nowhere
 * ('none'). The engine now derives which steps a future inherit/preset commitment has and where they
 * are placed, every run (the routine step timing design note, `engine/core/src/engine.ts`'s
 * `deriveCommitmentRoutineSteps`), and the forecast persist's `syncCommitmentRoutineSteps`
 * (`plan-forecast-runtime.ts`) mirrors the engine's own rows for each commitment into `routine_steps`
 * by id, rather than resolving a preset and scheduling here itself. A step that was started, completed
 * or cancelled is a record of the day and its content (title, duration, contexts, action window,
 * phase, timing, status, scheduled times) is never rewritten or deleted, but that lock is per-step,
 * not per-commitment: a commitment with one done
 * step among several still-pending ones still receives a preset edit onto those pending steps. A
 * locked step's `sequence` is the one field that is not part of that lock — it is a sort key, not a
 * record of what happened, and every row of the commitment (locked included) always ends the
 * reconciliation carrying the engine's own final `sequence`, so `ORDER BY sequence`
 * (`portal/server/persistence/postgres/readers/routine-read.ts`, `portal/features/now/now-model.ts`) always
 * reads out in true routine order regardless of which steps are locked.
 */

// CommitmentRoutineStepInput is imported from @openrhen/contracts and re-exported below

/**
 * Which anchor a routine-step write targets — a
 * commitment's own preparation (`commitmentId` doubles as `anchorId`, `purpose` absent) or a bedtime/wake
 * step (`anchorId` is the sleep plan's id, `commitmentId` absent, `purpose` required). Mirrors the DB's
 * own `routine_steps_anchor_check`.
 */
export type RoutineStepAnchor =
  | { anchorType: "commitment"; anchorId: string; commitmentId: string }
  | { anchorType: "sleep_plan"; anchorId: string; purpose: "bedtime" | "wake" };

/**
 * Replaces a commitment's routine steps with the given list, inserted pending and unplaced — the
 * engine's next run places them (the routine step timing design note; the engine is the only placer
 * now). The single write path import review uses (stamping explicitly reviewed steps): "copy a routine
 * onto a commitment" always means the same inserts and the same dependency rows.
 */
export async function replaceCommitmentRoutineSteps(
  // `portal/server/persistence/postgres/imports/upserts.ts` calls this from inside its own already-open
  // transaction (routine review during import commit), passing a real `postgres.TransactionSql` — this
  // only ever runs tagged-template queries and `sql.json`, which both handles provide identically.
  sql: postgres.Sql | postgres.TransactionSql,
  userId: string,
  commitmentId: string,
  steps: readonly CommitmentRoutineStepInput[]
): Promise<void> {
  await sql`DELETE FROM routine_steps WHERE commitment_id=${commitmentId}`;
  const ids = steps.map(() => crypto.randomUUID());
  for (const [sequence, step] of steps.entries()) {
    await sql`
      INSERT INTO routine_steps (id,user_id,commitment_id,anchor_type,anchor_id,title,duration_minutes,sequence,timing_rule,max_lead_minutes,energy,phase,contexts,action_window_id,cadence_action_id,preset_step_id,status,wait_after_minutes,must_start_by_minutes,preferred_bands)
      VALUES (${ids[sequence]!},${userId},${commitmentId},'commitment',${commitmentId},${step.title},${step.durationMinutes},${sequence},${step.timingRule},${step.maxLeadMinutes},${step.energy},${step.phase},${sql.json(step.contexts as never)},${step.actionWindowId},${step.cadenceActionId},${step.presetStepId},'pending',${step.waitAfterMinutes ?? 0},${step.mustStartByMinutes ?? null},${sql.json((step.preferredBands ?? []) as never)})
    `;
  }
  for (const [sequence, step] of steps.entries()) {
    for (const dependency of step.dependsOn) {
      const dependencyId = ids[dependency];
      if (dependencyId === undefined || dependency === sequence) throw new Error("A routine connection is invalid.");
      await sql`INSERT INTO routine_step_dependencies (step_id,depends_on_step_id) VALUES (${ids[sequence]!},${dependencyId})`;
    }
  }
}

// CommitmentRoutineStepInput, ExistingRoutineStepForPlan, RoutineStepPlanOp, RoutineStepScheduleRow,
// RoutineStepReconciliationPlan, and planRoutineStepReconciliation are imported from @openrhen/contracts
// and re-exported below so existing importers keep compiling unchanged.
export { planRoutineStepReconciliation, contextList } from "@openrhen/contracts";
export type {
  CommitmentRoutineStepInput,
  ExistingRoutineStepForPlan,
  RoutineStepPlanOp,
  RoutineStepScheduleRow,
  RoutineStepReconciliationPlan
} from "@openrhen/contracts";

/**
 * Applies a reconciliation plan's writes for one anchor. Assumes `plan.changed` — callers skip this
 * call otherwise. A commitment-anchored template never sets `step.status`/`scheduledStartAt`/
 * `scheduledEndAt`, so `${op.step.status ?? "pending"}` and the schedule columns below always insert
 * `'pending'`/`NULL` for that anchor unless the caller supplies a real placement (`syncCommitmentRoutineSteps`,
 * `plan-forecast-runtime.ts`, mirrors the engine's own placed rows straight onto the template it builds).
 * A sleep-anchored template (`reconcileSleepRoutineSteps`) supplies both explicitly, since there is no
 * `commitments` row for either path to chain a schedule from any more — the engine is the only
 * placer.
 *
 * The content `UPDATE` and the `DELETE` are guarded by `status='pending'`: every op the caller builds
 * is only ever proposed against a row that was pending at read time, but a step can start or finish in
 * the gap between that read and this write (a live session, an arrival skip), and such a step must
 * survive untouched rather than have its record of the day overwritten or removed. `RETURNING id` off
 * the guarded `UPDATE` is what the row actually looks like now, so a row the guard silently skipped
 * (raced to non-pending) also skips the dependency rewrite below, keeping its real edges. The two
 * sequence writes (negative, then final) carry no guard — a locked row's `reseq` is sanctioned
 * regardless of status, since sequence is a sort key, never a record of what happened.
 */
export async function applyRoutineStepPlan(
  sql: postgres.Sql,
  userId: string,
  anchor: RoutineStepAnchor,
  plan: RoutineStepReconciliationPlan
): Promise<void> {
  const deletes = plan.ops.filter((op): op is Extract<RoutineStepPlanOp, { kind: "delete" }> => op.kind === "delete");
  const updates = plan.ops.filter((op): op is Extract<RoutineStepPlanOp, { kind: "update" }> => op.kind === "update");
  const reseqs = plan.ops.filter((op): op is Extract<RoutineStepPlanOp, { kind: "reseq" }> => op.kind === "reseq");
  const inserts = plan.ops.filter((op): op is Extract<RoutineStepPlanOp, { kind: "insert" }> => op.kind === "insert");
  const moved: ReadonlyArray<{ id: string; sequence: number }> = [...updates, ...reseqs];
  const commitmentId = anchor.anchorType === "commitment" ? anchor.commitmentId : null;
  const purpose = anchor.anchorType === "sleep_plan" ? anchor.purpose : null;
  // Dependency edges to/from a deleted row cascade away with it (both FK columns on
  // routine_step_dependencies are `onDelete: "cascade"`). Guarded: a step that started or finished
  // between the read and this write is a record of the day and must never be deleted out from under it.
  if (deletes.length)
    await sql`DELETE FROM routine_steps WHERE id IN ${sql(deletes.map((op) => op.id))} AND status='pending'`;
  // Every row whose sequence is changing — a content update or a locked row's reseq alike — moves to
  // a temporary negative sequence first: two rows swapping template positions (or a locked row landing
  // on a freshly inserted row's slot) would otherwise collide on the anchor's own sequence-uniqueness
  // index mid-flight (per-statement, not deferred). The final contiguous 0..n-1 sequence lands once
  // every moving row is out of the way and any inserts have claimed their slot. Unguarded — sequence is
  // a sort key, not a record of what happened, so it may move under a row of any status.
  for (const op of moved) await sql`UPDATE routine_steps SET sequence=${-(op.sequence + 1)} WHERE id=${op.id}`;
  const actuallyUpdatedIds = new Set<string>();
  for (const op of updates) {
    const rows = await sql<{ id: string }[]>`
      UPDATE routine_steps
      SET title=${op.step.title}, duration_minutes=${op.step.durationMinutes},
          timing_rule=${op.step.timingRule}, max_lead_minutes=${op.step.maxLeadMinutes}, energy=${op.step.energy},
          phase=${op.step.phase}, contexts=${sql.json(op.step.contexts as never)},
          action_window_id=${op.step.actionWindowId}, cadence_action_id=${op.step.cadenceActionId},
          preset_step_id=${op.step.presetStepId},
          status=${op.step.status ?? "pending"},
          scheduled_start_at=${op.step.scheduledStartAt ?? null}, scheduled_end_at=${op.step.scheduledEndAt ?? null},
          wait_after_minutes=${op.step.waitAfterMinutes ?? 0}, must_start_by_minutes=${op.step.mustStartByMinutes ?? null},
          preferred_bands=${sql.json((op.step.preferredBands ?? []) as never)},
          updated_at=CURRENT_TIMESTAMP
      WHERE id=${op.id} AND status='pending'
      RETURNING id
    `;
    if (rows[0]) actuallyUpdatedIds.add(op.id);
  }
  // An updated row keeps its id, so its stale outgoing edges need clearing before the fresh ones land —
  // only for a row the guard above actually touched; one it skipped (raced to non-pending) keeps its
  // real edges. A reseq row's dependencies are untouched — only its sequence (a sort key) moves.
  if (actuallyUpdatedIds.size)
    await sql`DELETE FROM routine_step_dependencies WHERE step_id IN ${sql([...actuallyUpdatedIds])}`;
  for (const op of inserts) {
    await sql`
      INSERT INTO routine_steps
        (id,user_id,commitment_id,anchor_type,anchor_id,purpose,title,duration_minutes,sequence,timing_rule,max_lead_minutes,energy,phase,contexts,action_window_id,cadence_action_id,preset_step_id,status,scheduled_start_at,scheduled_end_at,wait_after_minutes,must_start_by_minutes,preferred_bands)
      VALUES
        (${op.id},${userId},${commitmentId},${anchor.anchorType},${anchor.anchorId},${purpose},${op.step.title},${op.step.durationMinutes},${op.sequence},${op.step.timingRule},${op.step.maxLeadMinutes},${op.step.energy},${op.step.phase},${sql.json(op.step.contexts as never)},${op.step.actionWindowId},${op.step.cadenceActionId},${op.step.presetStepId},${op.step.status ?? "pending"},${op.step.scheduledStartAt ?? null},${op.step.scheduledEndAt ?? null},${op.step.waitAfterMinutes ?? 0},${op.step.mustStartByMinutes ?? null},${sql.json((op.step.preferredBands ?? []) as never)})
    `;
  }
  for (const op of moved) await sql`UPDATE routine_steps SET sequence=${op.sequence} WHERE id=${op.id}`;
  for (const op of inserts)
    for (const dependsOnStepId of op.dependsOnIds)
      await sql`INSERT INTO routine_step_dependencies (step_id,depends_on_step_id) VALUES (${op.id},${dependsOnStepId})`;
  for (const op of updates) {
    if (!actuallyUpdatedIds.has(op.id)) continue;
    for (const dependsOnStepId of op.dependsOnIds)
      await sql`INSERT INTO routine_step_dependencies (step_id,depends_on_step_id) VALUES (${op.id},${dependsOnStepId})`;
  }
}

/**
 * Reconciles one commitment's routine steps in place against `template` (see
 * `planRoutineStepReconciliation`). The engine is the only placer now:
 * a fresh `insert`/`update` row lands exactly as `template` describes it, unplaced unless the caller's
 * own template already carries a placement (the persist's `syncCommitmentRoutineSteps` passes the
 * engine's own placed rows as its template, so a step it just inserted arrives already placed; nothing
 * else writes `scheduled_start_at`/`scheduled_end_at` here at all). A commitment whose plan has nothing
 * to change (`plan.changed` false) does no writes at all.
 */
export async function reconcileCommitmentRoutineSteps(
  sql: postgres.Sql,
  userId: string,
  commitmentId: string,
  existing: readonly ExistingRoutineStepForPlan[],
  template: readonly CommitmentRoutineStepInput[]
): Promise<RoutineStepReconciliationPlan> {
  const plan = planRoutineStepReconciliation(existing, template);
  if (!plan.changed) return plan;
  await applyRoutineStepPlan(sql, userId, { anchorType: "commitment", anchorId: commitmentId, commitmentId }, plan);
  return plan;
}

/**
 * Reconciles one sleep plan's bedtime or wake routine steps in place — the sleep-anchored twin of
 * `reconcileCommitmentRoutineSteps`. The engine's own
 * `deriveSleepRoutineSteps` has already decided each template step's `status` and
 * `scheduledStartAt`/`scheduledEndAt` — there is no separate placer to call here, the engine is the
 * only one — so `applyRoutineStepPlan` writes both straight
 * from the template.
 */
export async function reconcileSleepRoutineSteps(
  sql: postgres.Sql,
  userId: string,
  anchorId: string,
  purpose: "bedtime" | "wake",
  existing: readonly ExistingRoutineStepForPlan[],
  template: readonly CommitmentRoutineStepInput[],
  // The caller's own deterministic id per template index, mirroring the engine's — see
  // `planRoutineStepReconciliation`'s `generateId` doc comment.
  generateId?: (templateIndex: number) => string
): Promise<RoutineStepReconciliationPlan> {
  const plan = generateId
    ? planRoutineStepReconciliation(existing, template, generateId)
    : planRoutineStepReconciliation(existing, template);
  if (!plan.changed) return plan;
  await applyRoutineStepPlan(sql, userId, { anchorType: "sleep_plan", anchorId, purpose }, plan);
  return plan;
}

/**
 * Whether a preset step row should be offered in today's template. No link at all always offers the
 * step — an ordinary preparation step, unaffected by cadence. A link this gate cannot evaluate —
 * `cadenceActionId` set but missing from `cadenceGateByActionId`, meaning the action no longer exists,
 * was never `schedulingMode: 'cadence'`, or lost its rule — used to fail open (included every day,
 *): a linked action that quietly stopped being cadence-scheduled then behaved as an ordinary,
 * always-on instructional step forever, never recording a completion anywhere. It now fails closed:
 * not due, so not offered, the same as any other day the cadence isn't due — never silently included.
 * Write-time validation (`linkedCadenceAction`, `portal/server/persistence/postgres/entity-commands.ts`)
 * now refuses a new link to a non-cadence action, so this branch should only ever catch a link that
 * stopped being valid after it was saved.
 */
export function isPresetStepEligibleToday(
  cadenceActionId: string | null,
  cadenceGateByActionId: ReadonlyMap<string, CadenceGateRule>,
  now: Date
): boolean {
  if (!cadenceActionId) return true;
  const gate = cadenceGateByActionId.get(cadenceActionId);
  if (!gate) return false;
  return isCadenceStepEligibleToday(gate, now);
}
