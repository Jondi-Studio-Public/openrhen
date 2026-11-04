import { InvalidCommandError, badValue, invalidChoice, notFound } from "./command-errors";
import {
  nonNegativeInt,
  optionalBoolean,
  optionalDate,
  optionalText,
  positiveInt,
  requiredText,
  scoreInt,
  stableUuid,
  stringList
} from "./command-values";
import { hasCycle } from "./graph-checks";
import {
  assertNoPrerequisiteCycle,
  deletePrerequisitesOf,
  parsePrerequisiteRefs,
  replacePrerequisites,
  resolvePrerequisiteRefs
} from "./prerequisites";
import { assertNoClosedTransition } from "./close-floor";
import type { Sql } from "./sql-pool";

/**
 * Writes one deliverable and every child it owns. Shared by the save command and by whole-state
 * replacement so both produce the same rows; the contract and the plan are approved together, and a
 * half-applied save would misrepresent what the user agreed to.
 *
 * Caller resolves identity, project ownership and the expected version. Children are replaced
 * wholesale, except steps, which are updated in place so logged session time stays attached; deleting a
 * dropped step cascades its prerequisites, requirement pathways, and the criterion and blocker links.
 */
const VERIFICATION_METHODS: readonly string[] = [
  "llm_inspection",
  "user_confirmation",
  "submission_receipt",
  "external_result",
  "not_verifiable"
];

export async function writeDeliverableAggregate(
  tx: Sql,
  userId: string,
  id: string,
  projectId: string,
  entity: Record<string, unknown>,
  /** Whole-state replacement writes `prerequisites` itself once every target exists. */
  options: { skipPrerequisites?: boolean } = {}
): Promise<void> {
  const existing = await tx<{ id: string; private: boolean }[]>`SELECT id,private FROM deliverables WHERE id=${id}`;
  const title = requiredText(entity.title, "Deliverable title");
  const status = optionalText(entity.status) ?? "needs_breakdown";
  const allowedDeliverableStatus: readonly string[] = [
    "needs_breakdown",
    "ready",
    "in_progress",
    "under_review",
    "awaiting_result",
    "ready_to_complete",
    "completed",
    "cancelled",
    "archived"
  ];
  if (!allowedDeliverableStatus.includes(status))
    throw invalidChoice("status", status, allowedDeliverableStatus, { label: "Deliverable status" });
  const externalDeadline = optionalDate(entity.externalDeadlineAt, "externalDeadlineAt");
  const internalDeadline = optionalDate(entity.internalDeadlineAt, "internalDeadlineAt");
  if (internalDeadline && externalDeadline && internalDeadline > externalDeadline)
    throw badValue(
      "Internal deadline",
      entity.internalDeadlineAt,
      `it cannot be after the external deadline (${String(entity.externalDeadlineAt)}); send an earlier internalDeadlineAt`
    );
  const uncertainty = optionalText(entity.uncertainty) ?? "some";
  const allowedDeliverableUncertainty: readonly string[] = ["known", "some", "high"];
  if (!allowedDeliverableUncertainty.includes(uncertainty))
    throw invalidChoice("uncertainty", uncertainty, allowedDeliverableUncertainty, {
      label: "Deliverable uncertainty"
    });
  const importance = scoreInt(entity.importance ?? 3, "Importance");
  const consequence = scoreInt(entity.consequence ?? 3, "Consequence");
  const contractVersion = nonNegativeInt(entity.contractVersion ?? 0, "Contract version");
  const planVersion = nonNegativeInt(entity.planVersion ?? 0, "Plan version");
  const details = optionalText(entity.details);
  const threshold = optionalText(entity.completionThreshold);
  const approvalNote = optionalText(entity.approvalNote);
  const contractApprovedAt = optionalDate(entity.contractApprovedAt, "contractApprovedAt");
  const planApprovedAt = optionalDate(entity.planApprovedAt, "planApprovedAt");
  const submittedAt = optionalDate(entity.submittedAt, "submittedAt");
  const sortOrder = nonNegativeInt(entity.sortOrder ?? 0, "Order");
  const completedAt = optionalDate(entity.completedAt, "completedAt");
  // The pulse criteria and publish design note ("Private"): absent on update leaves the stored value
  // untouched, same as every other flag in this module — an aggregate save that never heard of privacy
  // must not silently unhide a deliverable.
  const isPrivate = optionalBoolean(entity.private) ?? existing[0]?.private ?? false;
  if (existing[0])
    await tx`UPDATE deliverables SET project_id=${projectId},title=${title},details=${details},status=${status},external_deadline_at=${externalDeadline},internal_deadline_at=${internalDeadline},uncertainty=${uncertainty},importance=${importance},consequence=${consequence},completion_threshold=${threshold},contract_version=${contractVersion},plan_version=${planVersion},contract_approved_at=${contractApprovedAt},plan_approved_at=${planApprovedAt},approval_note=${approvalNote},submitted_at=${submittedAt},sort_order=${sortOrder},completed_at=${completedAt},private=${isPrivate},version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=${id}`;
  else
    await tx`INSERT INTO deliverables (id,project_id,title,details,status,external_deadline_at,internal_deadline_at,uncertainty,importance,consequence,completion_threshold,contract_version,plan_version,contract_approved_at,plan_approved_at,approval_note,submitted_at,sort_order,completed_at,private) VALUES (${id},${projectId},${title},${details},${status},${externalDeadline},${internalDeadline},${uncertainty},${importance},${consequence},${threshold},${contractVersion},${planVersion},${contractApprovedAt},${planApprovedAt},${approvalNote},${submittedAt},${sortOrder},${completedAt},${isPrivate})`;

  const rawSteps: Record<string, unknown>[] = Array.isArray(entity.steps)
    ? (entity.steps as Record<string, unknown>[])
    : [];
  const rawCriteria: Record<string, unknown>[] = Array.isArray(entity.criteria)
    ? (entity.criteria as Record<string, unknown>[])
    : [];
  const rawBlockers: Record<string, unknown>[] = Array.isArray(entity.blockers)
    ? (entity.blockers as Record<string, unknown>[])
    : [];
  const stepIds = new Map<string, string>();
  for (const step of rawSteps) {
    const raw = requiredText(step.id, "Step id");
    if (stepIds.has(raw)) throw new InvalidCommandError("Every step needs a unique id.");
    stepIds.set(raw, await stableUuid(`deliverable-step:${id}`, raw));
  }
  const stepGraph = new Map<string, string[]>();
  for (const step of rawSteps) {
    const raw = requiredText(step.id, "Step id");
    const dependencies = stringList(step.dependencyIds);
    if (dependencies.includes(raw)) throw new InvalidCommandError("A step cannot depend on itself.");
    // Cross-deliverable ordering is a deliverable dependency, which is the level the engine can explain.
    for (const dependency of dependencies)
      if (!stepIds.has(dependency))
        throw new InvalidCommandError("A step prerequisite refers to a step that is not part of this deliverable.");
    stepGraph.set(raw, dependencies);
  }
  if (hasCycle(stepGraph)) throw new InvalidCommandError("Step prerequisites cannot form a cycle.");

  await tx`DELETE FROM deliverable_blockers WHERE deliverable_id=${id}`;
  await tx`DELETE FROM deliverable_criteria WHERE deliverable_id=${id}`;
  // action_dependencies.depends_on_action_id carries no ON DELETE CASCADE (a plain action is never
  // hard-deleted, so the shared table never needed one) — unlike the old deliverable_step_dependencies,
  // which cascaded from either side. A step's dependencyIds only ever name another step in the same
  // deliverable (validated above), so every dependency row touching this deliverable's actions is
  // deleted explicitly before the actions themselves, on both sides of the edge.
  await tx`DELETE FROM action_dependencies WHERE action_id IN (SELECT id FROM actions WHERE deliverable_id=${id}) OR depends_on_action_id IN (SELECT id FROM actions WHERE deliverable_id=${id})`;
  // A deliverable's steps are actions now, filtered by deliverable_id rather than a table of
  // their own. A step that survives the save keeps its row (`session_segments.step_id` is ON DELETE SET
  // NULL, so deleting and reinserting it would detach every logged minute from it); only steps the save
  // dropped are deleted, which cascades the same way deliverable_steps used to. A kept step's pathways
  // are rebuilt below, so they are cleared here.
  const keptStepIds = [...stepIds.values()];
  // postgres.js serialises an empty array as '' (a malformed array literal), so a save with no steps
  // takes the plain delete instead.
  // Steps the save drops take their extra prerequisites with them, in both directions.
  const droppedSteps = await tx<{ id: string }[]>`SELECT id FROM actions WHERE deliverable_id=${id}`;
  await deletePrerequisitesOf(
    tx,
    "action",
    droppedSteps.map((row) => row.id).filter((stepId) => !keptStepIds.includes(stepId))
  );
  if (keptStepIds.length) {
    await tx`DELETE FROM actions WHERE deliverable_id=${id} AND NOT (id = ANY(${keptStepIds}))`;
    await tx`DELETE FROM action_requirement_pathways WHERE action_id = ANY(${keptStepIds})`;
  } else await tx`DELETE FROM actions WHERE deliverable_id=${id}`;
  await tx`DELETE FROM deliverable_dependencies WHERE deliverable_id=${id}`;

  for (const [order, step] of rawSteps.entries()) {
    const stepId = stepIds.get(requiredText(step.id, "Step id"))!;
    const optimistic = positiveInt(step.optimisticMinutes, "Optimistic estimate");
    const expected = positiveInt(step.expectedMinutes, "Expected estimate");
    const pessimistic = positiveInt(step.pessimisticMinutes, "Pessimistic estimate");
    if (!(optimistic <= expected && expected <= pessimistic))
      throw new InvalidCommandError("Step effort estimates are out of order.");
    const remaining = nonNegativeInt(step.remainingMinutes ?? expected, "Remaining effort");
    const minimum = positiveInt(step.minimumSessionMinutes, "Minimum session");
    const maximum = positiveInt(step.maximumSessionMinutes, "Maximum session");
    if (minimum > maximum) throw new InvalidCommandError("Minimum session exceeds maximum session.");
    const stepStatus = optionalText(step.status) ?? "planned";
    // A step is an action row: an agent's save may not close it or reopen it any more than a direct action save may.
    await assertNoClosedTransition(tx, userId, "action", stepId, stepStatus);
    const allowedStepStatus: readonly string[] = ["planned", "doing", "waiting", "blocked", "done", "cancelled"];
    if (!allowedStepStatus.includes(stepStatus))
      throw invalidChoice("steps[].status", stepStatus, allowedStepStatus, { label: "Step status" });
    const reblock = step.reblockOnComplete as Record<string, unknown> | undefined;
    let reblockDescription: string | null = null;
    let reblockCategory: string | null = null;
    if (reblock && typeof reblock === "object") {
      reblockDescription = requiredText(reblock.description, "Step reblock description");
      reblockCategory = optionalText(reblock.category) ?? "other";
      const allowedStepReblockCategory: readonly string[] = [
        "missing_information",
        "waiting_on_someone",
        "prerequisite",
        "tool_or_context_unavailable",
        "technical_problem",
        "energy_or_health",
        "other"
      ];
      if (!allowedStepReblockCategory.includes(reblockCategory))
        throw invalidChoice("steps[].reblockOnComplete.category", reblockCategory, allowedStepReblockCategory, {
          label: "Step reblock category"
        });
    }
    // A deliverable's step is an action now: one row in `actions`, `deliverable_id` set,
    // `scheduling_mode` fixed at `one_off`, `details` stored in the same `notes` column a plain action
    // uses (a step never had a notes column of its own).
    await tx`INSERT INTO actions (id,project_id,deliverable_id,title,notes,completion_condition,status,scheduling_mode,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes,splittable,setup_minutes,required,sort_order,completed_at,reblock_description,reblock_category) VALUES (${stepId},${projectId},${id},${requiredText(step.title, "Step title")},${optionalText(step.details)},${optionalText(step.completionCondition)},${stepStatus},'one_off',${optimistic},${expected},${pessimistic},${remaining},${requiredText(step.energy, "Energy")},${minimum},${maximum},${step.splittable !== false},${nonNegativeInt(step.setupMinutes ?? 0, "Setup time")},${step.required !== false},${order},${optionalDate(step.completedAt, "completedAt")},${reblockDescription},${reblockCategory})
      ON CONFLICT (id) DO UPDATE SET project_id=EXCLUDED.project_id,title=EXCLUDED.title,notes=EXCLUDED.notes,completion_condition=EXCLUDED.completion_condition,status=EXCLUDED.status,optimistic_minutes=EXCLUDED.optimistic_minutes,expected_minutes=EXCLUDED.expected_minutes,pessimistic_minutes=EXCLUDED.pessimistic_minutes,remaining_minutes=EXCLUDED.remaining_minutes,remaining_set_at=CASE WHEN EXCLUDED.remaining_minutes IS DISTINCT FROM actions.remaining_minutes THEN CURRENT_TIMESTAMP ELSE actions.remaining_set_at END,energy=EXCLUDED.energy,minimum_session_minutes=EXCLUDED.minimum_session_minutes,maximum_session_minutes=EXCLUDED.maximum_session_minutes,splittable=EXCLUDED.splittable,setup_minutes=EXCLUDED.setup_minutes,required=EXCLUDED.required,sort_order=EXCLUDED.sort_order,completed_at=EXCLUDED.completed_at,reblock_description=EXCLUDED.reblock_description,reblock_category=EXCLUDED.reblock_category,updated_at=CURRENT_TIMESTAMP`;
    const pathways = Array.isArray(step.requirementPathways) ? (step.requirementPathways as unknown[]) : [];
    for (const [pathwayOrder, pathway] of pathways.entries()) {
      const contextKeys = stringList(
        Array.isArray(pathway) ? pathway : (pathway as Record<string, unknown>)?.contextIds
      );
      // A pathway with no requirements cannot be expressed by the model, so it is dropped rather than
      // stored as something that would read as "satisfiable anywhere".
      if (!contextKeys.length) continue;
      const pathwayId = await stableUuid(`deliverable-step-pathway:${stepId}`, String(pathwayOrder));
      await tx`INSERT INTO action_requirement_pathways (id,action_id,sort_order) VALUES (${pathwayId},${stepId},${pathwayOrder})`;
      for (const contextKey of contextKeys)
        await tx`INSERT INTO action_requirements (pathway_id,context_key) VALUES (${pathwayId},${contextKey})`;
    }
  }
  for (const step of rawSteps) {
    const stepId = stepIds.get(requiredText(step.id, "Step id"))!;
    for (const dependency of stringList(step.dependencyIds))
      await tx`INSERT INTO action_dependencies (action_id,depends_on_action_id) VALUES (${stepId},${stepIds.get(dependency)!})`;
  }

  const criterionKeys = new Set<string>();
  for (const [order, criterion] of rawCriteria.entries()) {
    const key = requiredText(criterion.key ?? criterion.id, "Criterion key");
    if (criterionKeys.has(key)) throw new InvalidCommandError("Every completion criterion needs a unique key.");
    criterionKeys.add(key);
    const criterionId = await stableUuid(`deliverable-criterion:${id}`, key);
    const state = optionalText(criterion.state) ?? "unsatisfied";
    const allowedCriterionState: readonly string[] = ["unsatisfied", "satisfied", "uncertain", "not_applicable"];
    if (!allowedCriterionState.includes(state))
      throw invalidChoice("criteria[].state", state, allowedCriterionState, { label: "Criterion state" });
    const verification = optionalText(criterion.verificationMethod);
    if (verification && !VERIFICATION_METHODS.includes(verification))
      throw invalidChoice("criteria[].verificationMethod", verification, VERIFICATION_METHODS, {
        label: "Criterion verification method"
      });
    await tx`INSERT INTO deliverable_criteria (id,deliverable_id,key,title,required,interpretation,source_document,source_location,expected_evidence,verification_method,state,notes,sort_order) VALUES (${criterionId},${id},${key},${requiredText(criterion.title, "Criterion title")},${criterion.required !== false},${optionalText(criterion.interpretation)},${optionalText(criterion.sourceDocument)},${optionalText(criterion.sourceLocation)},${optionalText(criterion.expectedEvidence)},${verification},${state},${optionalText(criterion.notes)},${order})`;
    for (const raw of stringList(criterion.stepIds)) {
      const stepId = stepIds.get(raw);
      if (!stepId)
        throw new InvalidCommandError("A completion criterion refers to a step that is not part of this deliverable.");
      await tx`INSERT INTO deliverable_criterion_actions (criterion_id,action_id) VALUES (${criterionId},${stepId})`;
    }
  }
  for (const blocker of rawBlockers) {
    const blockerId = await stableUuid(`deliverable-blocker:${id}`, requiredText(blocker.id, "Blocker id"));
    const category = optionalText(blocker.category) ?? "other";
    const allowedBlockerCategory: readonly string[] = [
      "missing_information",
      "waiting_on_someone",
      "prerequisite",
      "tool_or_context_unavailable",
      "technical_problem",
      "energy_or_health",
      "other"
    ];
    if (!allowedBlockerCategory.includes(category))
      throw invalidChoice("blockers[].category", category, allowedBlockerCategory, { label: "Blocker category" });
    const blockerState = optionalText(blocker.state) ?? "open";
    const allowedBlockerState: readonly string[] = [
      "open",
      "awaiting_response",
      "possibly_resolved",
      "resolved",
      "dismissed"
    ];
    if (!allowedBlockerState.includes(blockerState))
      throw invalidChoice("blockers[].state", blockerState, allowedBlockerState, { label: "Blocker state" });
    await tx`INSERT INTO deliverable_blockers (id,deliverable_id,description,category,state,proposed_resolution,resolution_notes,confirmed_at,resolved_at) VALUES (${blockerId},${id},${requiredText(blocker.description, "Blocker description")},${category},${blockerState},${optionalText(blocker.proposedResolution)},${optionalText(blocker.resolutionNotes)},${optionalDate(blocker.confirmedAt, "confirmedAt")},${optionalDate(blocker.resolvedAt, "resolvedAt")})`;
    for (const raw of stringList(blocker.stepIds)) {
      const stepId = stepIds.get(raw);
      if (!stepId) throw new InvalidCommandError("A blocker refers to a step that is not part of this deliverable.");
      await tx`INSERT INTO deliverable_blocker_actions (blocker_id,action_id) VALUES (${blockerId},${stepId})`;
    }
  }

  const dependencyIds: string[] = [];
  for (const raw of stringList(entity.dependencyIds)) {
    const dependencyId = await stableUuid(`deliverable:${userId}`, raw);
    if (dependencyId === id) throw new InvalidCommandError("A deliverable cannot depend on itself.");
    const owned = await tx<
      { id: string }[]
    >`SELECT d.id FROM deliverables d JOIN projects p ON p.id=d.project_id JOIN outcomes o ON o.id=p.outcome_id JOIN areas a ON a.id=o.area_id WHERE d.id=${dependencyId} AND a.user_id=${userId}`;
    if (!owned[0]) throw notFound("deliverable", dependencyId, "Prerequisite deliverable");
    dependencyIds.push(dependencyId);
  }
  // Checked against every other stored edge, because a cycle is only visible from the whole graph.
  const otherEdges = await tx<{ deliverable_id: string; depends_on_deliverable_id: string }[]>`
    SELECT dd.deliverable_id, dd.depends_on_deliverable_id FROM deliverable_dependencies dd
    JOIN deliverables d ON d.id=dd.deliverable_id JOIN projects p ON p.id=d.project_id JOIN outcomes o ON o.id=p.outcome_id JOIN areas a ON a.id=o.area_id
    WHERE a.user_id=${userId} AND dd.deliverable_id<>${id}
  `;
  const deliverableGraph = new Map<string, string[]>([[id, dependencyIds]]);
  for (const edge of otherEdges)
    deliverableGraph.set(edge.deliverable_id, [
      ...(deliverableGraph.get(edge.deliverable_id) ?? []),
      edge.depends_on_deliverable_id
    ]);
  if (hasCycle(deliverableGraph)) throw new InvalidCommandError("Deliverable dependencies cannot form a cycle.");
  for (const dependencyId of dependencyIds)
    await tx`INSERT INTO deliverable_dependencies (deliverable_id,depends_on_deliverable_id) VALUES (${id},${dependencyId})`;
  // `prerequisites` absent leaves the stored edges alone; present replaces them all.
  const wanted = options.skipPrerequisites ? undefined : parsePrerequisiteRefs(entity.prerequisites);
  if (wanted) {
    await replacePrerequisites(
      tx,
      { kind: "deliverable", id },
      await resolvePrerequisiteRefs(tx, userId, { kind: "deliverable", id }, wanted)
    );
  }
  if (!options.skipPrerequisites) await assertNoPrerequisiteCycle(tx, userId);
}
