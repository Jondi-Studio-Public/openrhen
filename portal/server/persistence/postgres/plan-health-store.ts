import {
  effectiveMode,
  PLAN_HEALTH_CHECKS,
  PLAN_HEALTH_COMMITMENT_LOOKBACK_DAYS,
  PLAN_HEALTH_EMAIL_LOOKBACK_DAYS,
  healthFindingKey,
  runPlanHealthChecks,
  type HealthFindingDraft,
  type HealthSnapshot
} from "@openrhen/contracts";
import {
  actions as actionsTable,
  deliverableBlockers,
  deliverables as deliverablesTable,
  commitments as commitmentsTable,
  planFindings,
  planLinks,
  planSubjects,
  projects as projectsTable,
  captures as capturesTable
} from "@openrhen/database";
import type { Row } from "./db-row";
import "./private/index";
import { readPlanHealthEmails } from "./plan-health-extensions";
import type { Sql } from "./sql-pool";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Plan health checks: loads a read-only snapshot of the
 * plan for one user, runs the pure checks and writes new drafts to `plan_findings`. Advisory: it reads plan
 * rows, writes only `plan_findings`, and does nothing while the `health_checks` switch is off. `shadow` and
 * `on` both write findings today, because nothing consumes them but the Links and findings window.
 */

// `id::text` and `status::text` are casts below, so the enum `status` widens to `string` and stays hand-typed.
type ProjectRow = Row<typeof projectsTable, "title" | "external_deadline_at"> & { id: string; status: string };

export async function loadHealthSnapshot(sql: Sql, userId: string, now: Date): Promise<HealthSnapshot> {
  const [preferences] = await sql<{ plan_code_pattern: string | null }[]>`
    SELECT plan_code_pattern FROM user_preferences WHERE user_id = ${userId}
  `;
  const projects = await sql<ProjectRow[]>`
    SELECT p.id::text AS id, p.title, p.status::text AS status, p.external_deadline_at
    FROM projects p JOIN outcomes o ON o.id = p.outcome_id JOIN areas a ON a.id = o.area_id
    WHERE a.user_id = ${userId}
  `;
  const deliverables = await sql<
    (Row<typeof deliverablesTable, "title" | "external_deadline_at"> & {
      // Casts and subquery counts, so hand-typed.
      id: string;
      project_id: string;
      status: string;
      action_count: number;
      criterion_count: number;
    })[]
  >`
    SELECT d.id::text AS id, d.project_id::text AS project_id, d.title, d.status::text AS status, d.external_deadline_at,
      (SELECT count(*)::int FROM actions x WHERE x.deliverable_id = d.id) AS action_count,
      (SELECT count(*)::int FROM deliverable_criteria c WHERE c.deliverable_id = d.id) AS criterion_count
    FROM deliverables d JOIN projects p ON p.id = d.project_id JOIN outcomes o ON o.id = p.outcome_id
      JOIN areas a ON a.id = o.area_id
    WHERE a.user_id = ${userId}
  `;
  const actions = await sql<
    (Row<typeof actionsTable, "title" | "deadline_at" | "scheduling_mode"> & {
      id: string;
      project_id: string;
      status: string;
    })[]
  >`
    SELECT x.id::text AS id, x.project_id::text AS project_id, x.title, x.status::text AS status, x.deadline_at,
      x.scheduling_mode
    FROM actions x JOIN projects p ON p.id = x.project_id JOIN outcomes o ON o.id = p.outcome_id
      JOIN areas a ON a.id = o.area_id
    WHERE a.user_id = ${userId} AND x.deliverable_id IS NULL
  `;
  const blockers = await sql<
    (Row<typeof deliverableBlockers, "description"> & {
      id: string;
      deliverable_id: string;
      category: string;
      state: string;
    })[]
  >`
    SELECT b.id::text AS id, b.deliverable_id::text AS deliverable_id, b.description, b.category::text AS category,
      b.state::text AS state
    FROM deliverable_blockers b JOIN deliverables d ON d.id = b.deliverable_id JOIN projects p ON p.id = d.project_id
      JOIN outcomes o ON o.id = p.outcome_id JOIN areas a ON a.id = o.area_id
    WHERE a.user_id = ${userId}
  `;
  const commitments = await sql<(Row<typeof commitmentsTable, "title" | "starts_at" | "status"> & { id: string })[]>`
    SELECT id::text AS id, title, starts_at, status FROM commitments
    WHERE user_id = ${userId}
      AND starts_at >= ${new Date(now.getTime() - PLAN_HEALTH_COMMITMENT_LOOKBACK_DAYS * DAY_MS)}
  `;
  const emails = await readPlanHealthEmails(sql, new Date(now.getTime() - PLAN_HEALTH_EMAIL_LOOKBACK_DAYS * DAY_MS));
  const proposals = await sql<
    (Row<typeof capturesTable, "proposal_type"> & {
      // Casts and a JSON field extracted with `->>`.
      id: string;
      source_id: string;
      title: string | null;
      source_title: string | null;
    })[]
  >`
    SELECT p.id::text AS id, p.source_id::text AS source_id, p.proposal_type, p.proposed_fields->>'title' AS title,
      s.title AS source_title
    FROM captures p JOIN sources s ON s.id = p.source_id
    WHERE p.user_id = ${userId} AND p.status = 'pending'
  `;
  const links = await sql<Row<typeof planLinks, "from_type" | "from_id" | "to_type" | "to_id" | "kind" | "status">[]>`
    SELECT from_type, from_id, to_type, to_id, kind, status FROM plan_links WHERE user_id = ${userId}
  `;
  const subjects = await sql<Row<typeof planSubjects, "id" | "name" | "status">[]>`
    SELECT id, name, status FROM plan_subjects WHERE user_id = ${userId}
  `;
  return {
    now,
    projects: projects.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      externalDeadlineAt: row.external_deadline_at
    })),
    deliverables: deliverables.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      status: row.status,
      externalDeadlineAt: row.external_deadline_at,
      actionCount: row.action_count,
      criterionCount: row.criterion_count
    })),
    actions: actions.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      status: row.status,
      deadlineAt: row.deadline_at,
      schedulingMode: row.scheduling_mode
    })),
    blockers: blockers.map((row) => ({
      id: row.id,
      deliverableId: row.deliverable_id,
      description: row.description,
      category: row.category,
      state: row.state
    })),
    commitments: commitments.map((row) => ({
      id: row.id,
      title: row.title,
      startsAt: row.starts_at,
      status: row.status
    })),
    emails,
    proposals: proposals.map((row) => ({
      id: row.id,
      sourceId: row.source_id,
      proposalType: row.proposal_type,
      title: row.title?.trim() || row.source_title?.trim() || "(untitled)"
    })),
    links: links.map((row) => ({
      fromType: row.from_type,
      fromId: row.from_id,
      toType: row.to_type,
      toId: row.to_id,
      kind: row.kind,
      status: row.status
    })),
    subjects,
    codePattern: preferences?.plan_code_pattern ?? null
  };
}

export interface PlanHealthRunResult {
  /** The `health_checks` switch as it was read; `off` means nothing ran and nothing was written. */
  mode: "off" | "shadow" | "on";
  /** Drafts the checks produced. */
  found: number;
  /** New findings written; the rest were already stored, open or decided. */
  created: number;
  /** Open findings deleted because their gap has since closed. */
  cleared: number;
}

/**
 * One run for one user. A finding stored in any state (an accepted or dismissed one included) is not raised
 * again. An *open* health finding whose gap has closed, so this run no longer produces it, is deleted;
 * accepted and dismissed rows stay, which is what keeps the never-re-raise guarantee.
 */
export async function runPlanHealth(sql: Sql, userId: string, now: Date = new Date()): Promise<PlanHealthRunResult> {
  const mode = effectiveMode("health_checks", undefined);

  const drafts = runPlanHealthChecks(await loadHealthSnapshot(sql, userId, now));
  const current = new Set(drafts.map(healthFindingKey));
  const stored = await sql<Row<typeof planFindings, "id" | "check_name" | "text" | "status">[]>`
    SELECT id, check_name, text, status FROM plan_findings WHERE user_id = ${userId}
  `;
  const healthChecks = new Set<string>(PLAN_HEALTH_CHECKS);
  const clearedIds = stored
    .filter(
      (finding) =>
        finding.status === "open" &&
        healthChecks.has(finding.check_name) &&
        !current.has(healthFindingKey({ checkName: finding.check_name as never, text: finding.text }))
    )
    .map((finding) => finding.id);
  if (clearedIds.length > 0) {
    await sql`
      DELETE FROM plan_findings
      WHERE user_id = ${userId} AND status = 'open'
        AND id::text = ANY(ARRAY(SELECT jsonb_array_elements_text(${sql.json(clearedIds as never)})))
    `;
  }

  const seen = new Set(
    stored.map((finding) => healthFindingKey({ checkName: finding.check_name as never, text: finding.text }))
  );
  const fresh: HealthFindingDraft[] = [];
  for (const draft of drafts) {
    const key = healthFindingKey(draft);
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(draft);
  }
  if (fresh.length > 0) {
    const rows = fresh.map((draft) => ({
      check_name: draft.checkName,
      item_ids: draft.itemIds,
      text: draft.text,
      evidence: draft.evidence,
      suggested_changes: draft.suggestedChanges
    }));
    await sql`
      INSERT INTO plan_findings (user_id, check_name, item_ids, text, evidence, suggested_changes, status, created_at)
      SELECT ${userId}, r.check_name, r.item_ids, r.text, r.evidence, r.suggested_changes, 'open', ${now}
      FROM jsonb_to_recordset(${sql.json(rows as never)}) AS r(
        check_name text, item_ids jsonb, text text, evidence jsonb, suggested_changes jsonb
      )
    `;
  }
  return { mode, found: drafts.length, created: fresh.length, cleared: clearedIds.length };
}
