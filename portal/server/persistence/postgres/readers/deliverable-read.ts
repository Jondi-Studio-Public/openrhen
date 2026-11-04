import {
  actionRequirementPathways,
  actionRequirements,
  actions,
  deliverableBlockerActions,
  deliverableBlockers,
  deliverableCriteria,
  deliverableCriterionActions,
  deliverableDependencies,
  deliverableSources,
  deliverables,
  captures,
  sourceFiles,
  sources
} from "@openrhen/database";
import type { PortalState } from "@/state/portal-state";
import type { DbRow, Row } from "../db-row";
import { readPrerequisiteMap } from "../prerequisites";
import { iso } from "../row-values";
import type { Sql } from "../sql-pool";

type Deliverable = PortalState["deliverables"][number];
type Criterion = Deliverable["criteria"][number];
type Step = Deliverable["steps"][number];

/**
 * Every deliverable the user owns, with its steps, completion criteria, blockers, sources and
 * outstanding contract proposals. Split out of the whole-state read so one aggregate's queries sit
 * beside the mapping that turns them into the stored shape.
 */
export async function readDeliverables(sql: Sql, userId: string): Promise<PortalState["deliverables"]> {
  // A fresh fragment per use; a single one reused across queries is not safe to share.
  const ownedDeliverables = () =>
    sql`SELECT d.id FROM deliverables d JOIN projects p ON p.id=d.project_id JOIN outcomes o ON o.id=p.outcome_id JOIN areas a ON a.id=o.area_id WHERE a.user_id=${userId}`;
  const prerequisiteMap = await readPrerequisiteMap(sql, userId);
  const deliverableRows = await sql<DbRow<typeof deliverables>[]>`
      SELECT d.* FROM deliverables d
      JOIN projects p ON p.id = d.project_id JOIN outcomes o ON o.id = p.outcome_id JOIN areas a ON a.id = o.area_id
      WHERE a.user_id = ${userId} ORDER BY d.sort_order, d.created_at, d.id
    `;
  // A deliverable's steps are actions now: the same table plain actions live in, filtered to
  // this deliverable's own rows.
  const deliverableStepRows = await sql<
    (DbRow<typeof actions> & { status: Step["status"]; required: boolean })[]
  >`SELECT * FROM actions WHERE deliverable_id IN (${ownedDeliverables()}) ORDER BY deliverable_id, sort_order, id`;
  const deliverableCriterionRows = await sql<
    (DbRow<typeof deliverableCriteria> & { verification_method: Criterion["verificationMethod"] | null })[]
  >`SELECT * FROM deliverable_criteria WHERE deliverable_id IN (${ownedDeliverables()}) ORDER BY deliverable_id, sort_order, id`;
  const deliverableBlockerRows = await sql<
    DbRow<typeof deliverableBlockers>[]
  >`SELECT * FROM deliverable_blockers WHERE deliverable_id IN (${ownedDeliverables()}) ORDER BY deliverable_id, created_at, id`;
  const deliverableDependencyRows = await sql<
    Row<typeof deliverableDependencies, "deliverable_id" | "depends_on_deliverable_id">[]
  >`SELECT deliverable_id, depends_on_deliverable_id FROM deliverable_dependencies WHERE deliverable_id IN (${ownedDeliverables()}) ORDER BY created_at, depends_on_deliverable_id`;
  const deliverableSourceRows = await sql<
    Row<typeof deliverableSources, "deliverable_id" | "source_id">[]
  >`SELECT deliverable_id, source_id FROM deliverable_sources WHERE deliverable_id IN (${ownedDeliverables()}) ORDER BY source_id`;
  const deliverableSourceFileRows = await sql<
    (Row<typeof deliverableSources, "deliverable_id"> &
      Row<typeof sourceFiles, "id" | "source_id" | "filename" | "mime_type" | "byte_size" | "created_at">)[]
  >`
      SELECT ds.deliverable_id,sf.id,sf.source_id,sf.filename,sf.mime_type,sf.byte_size,sf.created_at
      FROM deliverable_sources ds JOIN source_files sf ON sf.source_id=ds.source_id
      WHERE ds.deliverable_id IN (${ownedDeliverables()}) ORDER BY ds.deliverable_id,sf.sort_order,sf.id`;
  const deliverableProposalRows = await sql<
    (DbRow<typeof captures> & { source_title: string | null } & Row<typeof sources, "source_type">)[]
  >`
      SELECT pr.*, s.title AS source_title, s.source_type
      FROM captures pr JOIN sources s ON s.id=pr.source_id
      WHERE pr.user_id=${userId} AND pr.matched_entity_type='deliverable' AND pr.matched_entity_id IN (${ownedDeliverables()})
      ORDER BY pr.created_at, pr.id`;
  const deliverableStepDependencyRows = await sql<
    { step_id: string; depends_on_step_id: string }[]
  >`SELECT ad.action_id AS step_id, ad.depends_on_action_id AS depends_on_step_id FROM action_dependencies ad JOIN actions s ON s.id = ad.action_id WHERE s.deliverable_id IN (${ownedDeliverables()}) ORDER BY ad.created_at, ad.depends_on_action_id`;
  const deliverableCriterionStepRows = await sql<
    (Row<typeof deliverableCriterionActions, "criterion_id"> & { step_id: string })[]
  >`SELECT cs.criterion_id, cs.action_id AS step_id FROM deliverable_criterion_actions cs JOIN deliverable_criteria c ON c.id = cs.criterion_id WHERE c.deliverable_id IN (${ownedDeliverables()}) ORDER BY cs.action_id`;
  const deliverableBlockerStepRows = await sql<
    (Row<typeof deliverableBlockerActions, "blocker_id"> & { step_id: string })[]
  >`SELECT bs.blocker_id, bs.action_id AS step_id FROM deliverable_blocker_actions bs JOIN deliverable_blockers b ON b.id = bs.blocker_id WHERE b.deliverable_id IN (${ownedDeliverables()}) ORDER BY bs.action_id`;
  const deliverableStepPathwayRows = await sql<
    (Row<typeof actionRequirementPathways, "id" | "sort_order"> & { step_id: string })[]
  >`SELECT rp.id, rp.action_id AS step_id, rp.sort_order FROM action_requirement_pathways rp JOIN actions s ON s.id = rp.action_id WHERE s.deliverable_id IN (${ownedDeliverables()}) ORDER BY rp.action_id, rp.sort_order`;
  const deliverableStepRequirementRows = await sql<
    Row<typeof actionRequirements, "pathway_id" | "context_key">[]
  >`SELECT req.pathway_id, req.context_key FROM action_requirements req JOIN action_requirement_pathways rp ON rp.id = req.pathway_id JOIN actions s ON s.id = rp.action_id WHERE s.deliverable_id IN (${ownedDeliverables()}) ORDER BY req.context_key`;
  const stepRequirementsByPathway = new Map<string, string[]>();
  for (const row of deliverableStepRequirementRows)
    stepRequirementsByPathway.set(row.pathway_id, [
      ...(stepRequirementsByPathway.get(row.pathway_id) ?? []),
      row.context_key
    ]);
  const pathwaysByStep = new Map<string, { id: string; contextIds: string[] }[]>();
  for (const row of deliverableStepPathwayRows) {
    // Same rule as actions: an empty pathway is not expressible, so it is dropped rather than
    // loaded as a requirement that reads as satisfiable anywhere.
    const contextIds = stepRequirementsByPathway.get(row.id) ?? [];
    if (!contextIds.length) continue;
    pathwaysByStep.set(row.step_id, [...(pathwaysByStep.get(row.step_id) ?? []), { id: row.id, contextIds }]);
  }
  return deliverableRows.map((row) => ({
    id: row.id,
    version: row.version,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    uncertainty: row.uncertainty,
    importance: row.importance,
    consequence: row.consequence,
    contractVersion: row.contract_version,
    planVersion: row.plan_version,
    sortOrder: row.sort_order,
    ...(row.details ? { details: row.details } : {}),
    ...(row.completion_threshold ? { completionThreshold: row.completion_threshold } : {}),
    ...(row.approval_note ? { approvalNote: row.approval_note } : {}),
    ...(iso(row.external_deadline_at) ? { externalDeadlineAt: iso(row.external_deadline_at)! } : {}),
    ...(iso(row.internal_deadline_at) ? { internalDeadlineAt: iso(row.internal_deadline_at)! } : {}),
    ...(iso(row.contract_approved_at) ? { contractApprovedAt: iso(row.contract_approved_at)! } : {}),
    ...(iso(row.plan_approved_at) ? { planApprovedAt: iso(row.plan_approved_at)! } : {}),
    ...(iso(row.submitted_at) ? { submittedAt: iso(row.submitted_at)! } : {}),
    ...(iso(row.last_worked_at) ? { lastWorkedAt: iso(row.last_worked_at)! } : {}),
    ...(iso(row.completed_at) ? { completedAt: iso(row.completed_at)! } : {}),
    ...(iso(row.created_at) ? { createdAt: iso(row.created_at)! } : {}),
    ...(row.private ? { private: true } : {}),
    dependencyIds: deliverableDependencyRows
      .filter((edge) => edge.deliverable_id === row.id)
      .map((edge) => edge.depends_on_deliverable_id),
    prerequisites: prerequisiteMap.get(`deliverable:${row.id}`) ?? [],
    sourceIds: deliverableSourceRows.filter((link) => link.deliverable_id === row.id).map((link) => link.source_id),
    sourceFiles: deliverableSourceFileRows
      .filter((file) => file.deliverable_id === row.id)
      .map((file) => ({
        id: file.id,
        sourceId: file.source_id,
        filename: file.filename,
        mimeType: file.mime_type,
        byteSize: file.byte_size,
        createdAt: file.created_at.toISOString()
      })),
    steps: deliverableStepRows
      .filter((step) => step.deliverable_id === row.id)
      .map((step) => ({
        id: step.id,
        version: step.version,
        title: step.title,
        status: step.status,
        optimisticMinutes: step.optimistic_minutes,
        expectedMinutes: step.expected_minutes,
        pessimisticMinutes: step.pessimistic_minutes,
        remainingMinutes: step.remaining_minutes,
        energy: step.energy,
        minimumSessionMinutes: step.minimum_session_minutes,
        maximumSessionMinutes: step.maximum_session_minutes,
        splittable: step.splittable,
        setupMinutes: step.setup_minutes,
        required: step.required,
        sortOrder: step.sort_order,
        // `details` is the same slot `actions.notes` already carries: a deliverable step never
        // had a separate notes column of its own.
        ...(step.notes ? { details: step.notes } : {}),
        ...(step.completion_condition ? { completionCondition: step.completion_condition } : {}),
        ...(step.estimate_needs_review ? { estimateNeedsReview: true } : {}),
        ...(iso(step.last_worked_at) ? { lastWorkedAt: iso(step.last_worked_at)! } : {}),
        ...(iso(step.completed_at) ? { completedAt: iso(step.completed_at)! } : {}),
        ...(step.reblock_description
          ? { reblockOnComplete: { description: step.reblock_description, category: step.reblock_category ?? "other" } }
          : {}),
        dependencyIds: deliverableStepDependencyRows
          .filter((edge) => edge.step_id === step.id)
          .map((edge) => edge.depends_on_step_id),
        requirementPathways: pathwaysByStep.get(step.id) ?? []
      })),
    criteria: deliverableCriterionRows
      .filter((criterion) => criterion.deliverable_id === row.id)
      .map((criterion) => ({
        id: criterion.id,
        version: criterion.version,
        key: criterion.key,
        title: criterion.title,
        required: criterion.required,
        state: criterion.state,
        sortOrder: criterion.sort_order,
        ...(criterion.interpretation ? { interpretation: criterion.interpretation } : {}),
        ...(criterion.source_document ? { sourceDocument: criterion.source_document } : {}),
        ...(criterion.source_location ? { sourceLocation: criterion.source_location } : {}),
        ...(criterion.expected_evidence ? { expectedEvidence: criterion.expected_evidence } : {}),
        ...(criterion.verification_method ? { verificationMethod: criterion.verification_method } : {}),
        ...(criterion.notes ? { notes: criterion.notes } : {}),
        stepIds: deliverableCriterionStepRows
          .filter((link) => link.criterion_id === criterion.id)
          .map((link) => link.step_id)
      })),
    blockers: deliverableBlockerRows
      .filter((blocker) => blocker.deliverable_id === row.id)
      .map((blocker) => ({
        id: blocker.id,
        version: blocker.version,
        description: blocker.description,
        category: blocker.category,
        state: blocker.state,
        ...(blocker.proposed_resolution ? { proposedResolution: blocker.proposed_resolution } : {}),
        ...(blocker.resolution_notes ? { resolutionNotes: blocker.resolution_notes } : {}),
        ...(iso(blocker.confirmed_at) ? { confirmedAt: iso(blocker.confirmed_at)! } : {}),
        ...(iso(blocker.resolved_at) ? { resolvedAt: iso(blocker.resolved_at)! } : {}),
        ...(iso(blocker.created_at) ? { createdAt: iso(blocker.created_at)! } : {}),
        stepIds: deliverableBlockerStepRows.filter((link) => link.blocker_id === blocker.id).map((link) => link.step_id)
      })),
    contractProposals: deliverableProposalRows
      .filter((proposal) => proposal.matched_entity_id === row.id)
      .map((proposal) => {
        const fields =
          proposal.proposed_fields && typeof proposal.proposed_fields === "object"
            ? (proposal.proposed_fields as Record<string, unknown>)
            : {};
        const optional = (name: string) =>
          typeof fields[name] === "string" && fields[name] ? (fields[name] as string) : undefined;
        const verification = optional(
          "verificationMethod"
        ) as PortalState["deliverables"][number]["contractProposals"][number]["verificationMethod"];
        return {
          id: proposal.id,
          version: proposal.version,
          sourceId: proposal.source_id,
          status: proposal.status,
          key: String(fields.key ?? proposal.id),
          title: String(fields.title ?? "Untitled requirement"),
          required: fields.required !== false,
          ...(optional("interpretation") ? { interpretation: optional("interpretation") } : {}),
          ...(optional("sourceDocument") ? { sourceDocument: optional("sourceDocument") } : {}),
          ...(optional("sourceLocation") ? { sourceLocation: optional("sourceLocation") } : {}),
          ...(optional("expectedEvidence") ? { expectedEvidence: optional("expectedEvidence") } : {}),
          ...(verification ? { verificationMethod: verification } : {}),
          ...(optional("notes") ? { notes: optional("notes") } : {}),
          basis: fields.basis === "explicit" || fields.basis === "inferred" ? fields.basis : "missing",
          confidence:
            fields.confidence === "high" || fields.confidence === "medium" || fields.confidence === "low"
              ? fields.confidence
              : null,
          evidence: Array.isArray(fields.evidence)
            ? fields.evidence.filter((item): item is string => typeof item === "string")
            : [],
          ...(proposal.source_title ? { sourceTitle: proposal.source_title } : {}),
          sourceType: proposal.source_type,
          createdAt: proposal.created_at.toISOString()
        };
      })
  }));
}
