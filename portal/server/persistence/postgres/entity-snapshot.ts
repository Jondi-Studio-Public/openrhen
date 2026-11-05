import { primarySourceIds, type ActivityCommand, type PlanningEntityCommand } from "@openrhen/contracts";
import "./private/index";
import { extensionSnapshotWatches, type SnapshotEvent } from "./entity-extensions";
import { stableUuid } from "./command-values";
import type { Sql } from "./sql-pool";
import type { WriteSnapshot } from "./write-snapshot";

/**
 * Which rows an agent's plan-data write touches, named before the write runs so `WriteSnapshot` can keep them as
 * they were and as the write left them. One place per command
 * family rather than a call inside every branch: each function mirrors what its command writes, using the same
 * id derivation (`stableUuid`), and registers conditions (`watch`) where the write deletes and re-inserts children
 * under new ids. A table a command can write that is not named here is not undone by a revert.
 */

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * An action's own row and everything `saveAction` replaces under it. When the save drops the recurrence rule, the
 * rule's cadence completions and occurrences go with it (`ON DELETE cascade`), so they are kept too and an undo puts
 * the history back; on any other save they are left alone, because the planner rewrites occurrences on its own.
 *
 * `keptWindowIds` is the save's incoming window list (ids as the save derives them) when the rule stays, or null when
 * the save drops the rule. A window the save deletes takes its occurrences with it (`action_occurrences.window_id`
 * is ON DELETE CASCADE, completed ones included) and unlinks the routine steps and preset steps that point at it
 * (`action_window_id` is ON DELETE SET NULL), so those are kept for the windows going and no others.
 */
export async function watchActionWrite(
  snap: WriteSnapshot | null,
  id: string,
  keptWindowIds: readonly string[] | null
): Promise<void> {
  if (!snap) return;
  const dropsRule = keptWindowIds === null;
  await snap.before("actions", [id]);
  await snap.watch("action_dependencies", "t.action_id = $1", [id]);
  await snap.watch("action_requirement_pathways", "t.action_id = $1", [id]);
  await snap.watch(
    "action_requirements",
    "t.pathway_id IN (SELECT p.id FROM action_requirement_pathways p WHERE p.action_id = $1)",
    [id]
  );
  await snap.watch("action_preferences", "t.action_id = $1", [id]);
  await snap.watch("action_recurrence_rules", "t.action_id = $1", [id]);
  await snap.watch(
    "action_recurrence_windows",
    "t.rule_id IN (SELECT r.id FROM action_recurrence_rules r WHERE r.action_id = $1)",
    [id]
  );
  if (dropsRule) {
    const ofRule = "t.rule_id IN (SELECT r.id FROM action_recurrence_rules r WHERE r.action_id = $1)";
    await snap.watch("action_cadence_completions", ofRule, [id]);
    await snap.watch("action_occurrences", ofRule, [id]);
  }
  // The windows this save deletes: all of the rule's when it is dropped, otherwise those missing from the list.
  const kept = keptWindowIds ?? [];
  const keptParams = kept.map((_, index) => `$${index + 2}`);
  const going = `(SELECT w.id FROM action_recurrence_windows w JOIN action_recurrence_rules r ON r.id = w.rule_id
    WHERE r.action_id = $1${kept.length ? ` AND w.id::text NOT IN (${keptParams.join(", ")})` : ""})`;
  if (!dropsRule) await snap.watch("action_occurrences", `t.window_id IN ${going}`, [id, ...kept]);
  await snap.watch("routine_steps", `t.action_window_id IN ${going}`, [id, ...kept]);
  await snap.watch("routine_preset_steps", `t.action_window_id IN ${going}`, [id, ...kept]);
  await snap.watch("entity_prerequisites", "t.entity_kind = 'action' AND t.entity_id = $1", [id]);
}

export async function watchProjectWrite(snap: WriteSnapshot | null, id: string): Promise<void> {
  if (!snap) return;
  await snap.before("projects", [id]);
  await snap.watch("entity_prerequisites", "t.entity_kind = 'project' AND t.entity_id = $1", [id]);
}

/**
 * A recurring commitment's rule, and the occurrences a series save detaches (started or in progress), closes (ending
 * the rule cancels its future ones) or brings back (setting an ended rule active again). Nothing is deleted: the
 * future occurrences and their routine steps change status, so those tables (and the prep actions that close with a date) are watched. An undo puts each back
 * as it was; the links, dependencies, extension rows and prep that hang off an occurrence are not touched.
 */
export async function watchCommitmentRecurrenceWrite(
  snap: WriteSnapshot | null,
  ruleId: string,
  changesOccurrences: boolean
): Promise<void> {
  if (!snap) return;
  await snap.before("commitment_recurrence_rules", [ruleId]);
  // A save that leaves the rule's status alone changes occurrences only through `applyOccurrenceInProgressRule`, which
  // keeps the ones it detaches itself.
  if (!changesOccurrences) return;
  await snap.watch("commitments", "t.recurrence_rule_id = $1", [ruleId]);
  // The occurrences the end closes or the re-activation reopens: the future ones.
  const going = "(SELECT f.id FROM commitments f WHERE f.recurrence_rule_id = $1 AND f.starts_at > now())";
  await snap.watch("routine_steps", `t.commitment_id IN ${going}`, [ruleId]);
  // The prep actions that close with a date and come back with it.
  await snap.watch("actions", `t.prep_for_commitment_id IN ${going}`, [ruleId]);
}

/** Ending a manual recurrence goal: the rule, the action and the occurrences still pending. */
export async function watchEndRecurrenceGoal(snap: WriteSnapshot | null, actionId: string): Promise<void> {
  if (!snap) return;
  await snap.before("actions", [actionId]);
  await snap.watch("action_recurrence_rules", "t.action_id = $1", [actionId]);
  await snap.watch(
    "action_occurrences",
    "t.status = 'pending' AND t.rule_id IN (SELECT r.id FROM action_recurrence_rules r WHERE r.action_id = $1)",
    [actionId]
  );
}

/**
 * A deliverable save's aggregate: the deliverable, its steps (actions) with their pathways and edges, criteria,
 * blockers and their step links, deliverable edges, extra prerequisites, and the open session the save rolls forward
 * (with its segments). A dropped step takes its pathways, preferences, daily-plan placements and prerequisites with
 * it and unlinks its logged segments and what extensions recorded, so those are kept for the dropped steps only: time
 * tracked since on a kept step does not make the undo stale.
 */
export async function watchDeliverableWrite(
  snap: WriteSnapshot | null,
  id: string,
  entity: Record<string, unknown>
): Promise<void> {
  if (!snap) return;
  const kept: string[] = [];
  if (Array.isArray(entity.steps))
    for (const step of entity.steps as Record<string, unknown>[])
      if (step && typeof step.id === "string" && step.id.trim())
        kept.push(await stableUuid(`deliverable-step:${id}`, step.id.trim()));
  await snap.before("deliverables", [id]);
  const steps = "SELECT s.id FROM actions s WHERE s.deliverable_id = $1";
  const dropped = `(SELECT s.id FROM actions s WHERE s.deliverable_id = $1${kept.length ? ` AND s.id::text NOT IN (${kept.map((_, index) => `$${index + 2}`).join(", ")})` : ""})`;
  const droppedParams = [id, ...kept];
  await snap.watch("deliverable_dependencies", "t.deliverable_id = $1", [id]);
  await snap.watch("actions", "t.deliverable_id = $1", [id]);
  await snap.watch("action_dependencies", `t.action_id IN (${steps}) OR t.depends_on_action_id IN (${steps})`, [id]);
  await snap.watch("action_requirement_pathways", `t.action_id IN (${steps})`, [id]);
  await snap.watch(
    "action_requirements",
    `t.pathway_id IN (SELECT p.id FROM action_requirement_pathways p WHERE p.action_id IN (${steps}))`,
    [id]
  );
  await snap.watch("deliverable_criteria", "t.deliverable_id = $1", [id]);
  await snap.watch("deliverable_blockers", "t.deliverable_id = $1", [id]);
  await snap.watch(
    "deliverable_criterion_actions",
    "t.criterion_id IN (SELECT c.id FROM deliverable_criteria c WHERE c.deliverable_id = $1)",
    [id]
  );
  await snap.watch(
    "deliverable_blocker_actions",
    "t.blocker_id IN (SELECT b.id FROM deliverable_blockers b WHERE b.deliverable_id = $1)",
    [id]
  );
  await snap.watch("entity_prerequisites", "t.entity_kind = 'deliverable' AND t.entity_id = $1", [id]);
  await snap.watch(
    "entity_prerequisites",
    `(t.entity_kind = 'action' AND t.entity_id IN ${dropped}) OR (t.requires_kind = 'action' AND t.requires_id IN ${dropped})`,
    droppedParams
  );
  await snap.watch("action_preferences", `t.action_id IN ${dropped}`, droppedParams);
  await snap.watch("daily_plan_desired_actions", `t.action_id IN ${dropped}`, droppedParams);
  await snap.watch("daily_plan_deferred_actions", `t.action_id IN ${dropped}`, droppedParams);
  await snap.watch("session_segments", `t.step_id IN ${dropped}`, droppedParams);
  await watchExtensions(snap, { kind: "steps-dropped", dropped, params: droppedParams });
  // The running session the save may move onto the next step (`rollDeliverableSessionForward`).
  const running = (alias: string) =>
    `${alias}.target_type = 'deliverable' AND ${alias}.target_id = $1 AND ${alias}.status = 'running' AND ${alias}.ended_at IS NULL`;
  await snap.watch("sessions", running("t"), [id]);
  await snap.watch("session_segments", `t.session_id IN (SELECT x.id FROM sessions x WHERE ${running("x")})`, [id]);
}

/** Confirming a requirement proposal: the proposal, the criterion it adds and the deliverable it un-approves. */
export async function watchContractReviewWrite(
  snap: WriteSnapshot | null,
  proposalId: string,
  deliverableId: string | null
): Promise<void> {
  if (!snap) return;
  await snap.before("captures", [proposalId]);
  if (!deliverableId) return;
  await snap.before("deliverables", [deliverableId]);
  // The accepted criterion is made under the proposal's own id.
  await snap.before("deliverable_criteria", [proposalId]);
}

/** The rows one `entity` command can write, by entity type. A deliverable's aggregate has `watchDeliverableWrite`. */
export async function watchEntityWrite(
  snap: WriteSnapshot | null,
  userId: string,
  command: PlanningEntityCommand
): Promise<void> {
  if (!snap) return;
  const entity = command.entity as Record<string, unknown>;
  const rawId = typeof entity.id === "string" ? entity.id : command.commandId;
  switch (command.entityType) {
    case "area":
      return snap.before("areas", [await stableUuid(`area:${userId}`, rawId)]);
    case "outcome":
      return snap.before("outcomes", [await stableUuid(`outcome:${userId}`, rawId)]);
    case "commitment": {
      const id = await stableUuid(`commitment:${userId}`, rawId);
      await snap.before("commitments", [id]);
      // Cancelling or confirming settles what an extension told someone about it.
      await watchExtensions(snap, { kind: "commitment", id });
      return;
    }
    case "settings":
      await snap.before("users", [userId]);
      // Ticking or unticking the shift default moves the sharing of every imported shift.
      if (entity.sharePrimaryEvents !== undefined) {
        const primary = primarySourceIds();
        await snap.watch(
          "commitments",
          `t.user_id = $1 AND EXISTS (SELECT 1 FROM calendar_event_links l WHERE l.commitment_id = t.id AND ${
            primary.length ? `l.provider IN (${primary.map((_, index) => `$${index + 2}`).join(", ")})` : "FALSE"
          })`,
          [userId, ...primary]
        );
      }
      return snap.before("user_preferences", [userId]);
    case "current_availability":
      return snap.before("user_preferences", [userId]);
    case "condition_definition":
      return snap.before("condition_definitions", [
        [
          userId,
          String(entity.id ?? "")
            .trim()
            .toLocaleLowerCase()
        ]
      ]);
    case "routine_preset": {
      const id = await stableUuid(`routine-preset:${userId}`, rawId);
      await snap.before("routine_presets", [id]);
      await snap.watch("routine_preset_steps", "t.preset_id = $1", [id]);
      // Deleting a preset step unlinks the routine steps generated from it (ON DELETE SET NULL).
      await snap.watch(
        "routine_steps",
        "t.preset_step_id IN (SELECT s.id FROM routine_preset_steps s WHERE s.preset_id = $1)",
        [id]
      );
      await snap.watch(
        "routine_preset_step_dependencies",
        "t.step_id IN (SELECT s.id FROM routine_preset_steps s WHERE s.preset_id = $1)",
        [id]
      );
      return;
    }
    case "routine_step": {
      const id = await stableUuid(`routine:${userId}`, rawId);
      const commitmentId = await stableUuid(`commitment:${userId}`, String(entity.commitmentId ?? ""));
      await snap.before("routine_steps", [id]);
      // Hand-shaping a step detaches its commitment (and the one it came from) from the inherited routine.
      await snap.watch(
        "commitments",
        "t.id = $1 OR t.id IN (SELECT s.commitment_id FROM routine_steps s WHERE s.id = $2)",
        [commitmentId, id]
      );
      await snap.watch("routine_step_dependencies", "t.step_id = $1", [id]);
      return;
    }
    case "sleep_plan":
      return snap.before("sleep_plans", [await stableUuid(`sleep:${userId}`, rawId)]);
    case "sleep_log_entry": {
      const id = await stableUuid(`sleep-log:${userId}`, rawId);
      await snap.before("sleep_plans", [id]);
      // The log keeps the night's tracked session in step; and the last wake follows the log.
      await snap.watch("sessions", "t.target_type = 'sleep' AND t.target_id = $1", [id]);
      await snap.watch(
        "session_segments",
        "t.session_id IN (SELECT s.id FROM sessions s WHERE s.target_type = 'sleep' AND s.target_id = $1)",
        [id]
      );
      return snap.before("user_preferences", [userId]);
    }
    case "span":
      return snap.before("spans", [await stableUuid(`span:${userId}`, rawId)]);
    case "planning_focus": {
      const kind = String(entity.kind ?? "");
      const start = String(entity.periodStart ?? "").slice(0, 10);
      if (!LOCAL_DATE.test(start)) return;
      const period = "t.user_id = $1 AND t.kind = $2 AND t.period_start = $3::date";
      await snap.watch("planning_focus_periods", period, [userId, kind, start]);
      await snap.watch(
        "planning_focus_projects",
        `t.focus_period_id IN (SELECT t.id FROM planning_focus_periods t WHERE ${period})`,
        [userId, kind, start]
      );
      return;
    }
    case "capture": {
      const id = await stableUuid(`capture-proposal:${userId}`, rawId);
      await snap.before("sources", [await stableUuid(`capture-source:${userId}`, rawId)]);
      await snap.before("captures", [id]);
      // Ignoring a proposal declines what its sender submitted.
      await watchExtensions(snap, { kind: "capture", id });
      return;
    }
    case "daily_plan": {
      const localDate = String(entity.localDate ?? "").slice(0, 10);
      if (!LOCAL_DATE.test(localDate)) return;
      const plan = "t.user_id = $1 AND t.local_date = $2::date";
      await snap.watch("daily_plans", plan, [userId, localDate]);
      for (const table of ["daily_plan_desired_actions", "daily_plan_deferred_actions"] as const)
        await snap.watch(
          table,
          `t.daily_plan_id IN (SELECT p.id FROM daily_plans p WHERE p.user_id = $1 AND p.local_date = $2::date)`,
          [userId, localDate]
        );
      // Extending the horizon sets the person's current horizon too.
      if (entity.horizonOverrideAt !== undefined) await snap.before("user_preferences", [userId]);
      return;
    }
    default:
      // deliverable and deliverable_contract_review (watched in saveEntity, which has the stored ids), and
      // capture_review (which keeps its own "confirm" snapshot).
      return;
  }
}

/**
 * The rows an activity command (a routine-step, commitment, deliverable or sleep session, or skipping a step)
 * touches. `target` is the activity's own row, found from the command or, for a command on an open session, from
 * the session. Cadence credit for a finished routine step is kept by `recordCadenceCycle` itself.
 */
export async function watchActivityWrite(
  snap: WriteSnapshot | null,
  tx: Sql,
  userId: string,
  command: ActivityCommand
): Promise<void> {
  if (!snap) return;
  if (command.type === "skip_routine_step" || command.type === "reopen_routine_step") {
    await snap.before("routine_steps", [command.stepId]);
    return;
  }
  if (command.type === "start_activity") {
    const targetId = await stableUuid(`${command.targetType}:${userId}`, command.targetId);
    snap.inserted("sessions", [command.commandId]);
    await snap.watch("session_segments", "t.session_id = $1", [command.commandId]);
    if (command.targetType === "routine_step") await snap.before("routine_steps", [targetId]);
    else if (command.targetType === "fixed_commitment") await snap.before("commitments", [targetId]);
    else if (command.targetType === "deliverable") {
      await snap.before("deliverables", [targetId]);
      if (command.stepId) await snap.before("actions", [command.stepId]);
    } else await snap.before("sleep_plans", [targetId]);
    return;
  }
  const sessions = await tx<
    { target_id: string; target_type: string }[]
  >`SELECT target_id, target_type FROM sessions WHERE id=${command.sessionId} AND user_id=${userId}`;
  const session = sessions[0];
  if (!session) return;
  await snap.before("sessions", [command.sessionId]);
  await snap.watch("session_segments", "t.session_id = $1", [command.sessionId]);
  if (session.target_type === "routine_step") {
    await snap.before("routine_steps", [session.target_id]);
    // The occurrence it credits is kept by `completeStepActionOccurrence`, which knows which one it closes.
  } else if (session.target_type === "fixed_commitment") await snap.before("commitments", [session.target_id]);
  else if (session.target_type === "deliverable") {
    await snap.before("deliverables", [session.target_id]);
    await snap.watch("actions", "t.deliverable_id = $1", [session.target_id]);
  } else if (session.target_type === "sleep") {
    await snap.before("sleep_plans", [session.target_id]);
    await snap.before("user_preferences", [userId]);
  }
}

/** What the extensions registered need kept for an undo of this event. */
async function watchExtensions(snap: WriteSnapshot, event: SnapshotEvent): Promise<void> {
  for (const watch of extensionSnapshotWatches(event)) await snap.watch(watch.table, watch.where, watch.params);
}
