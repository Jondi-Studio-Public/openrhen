import { DOCTOR_OPEN_ACTION_STATUSES, type DoctorDuplicatesSlice } from "@openrhen/contracts";
import type { Sql } from "./sql-pool";

/**
 * The doctor's duplicates-and-dead-links reader: the facts `duplicateItems` checks.
 * Read-only, user-scoped and bounded. A link end that no longer exists is not read: the navigator skips it and the
 * daily sweep deletes it, so only ends that are present but finished (done, cancelled, archived) surface.
 */

const ACTION_LIMIT = 5000;
const PROPOSAL_LIMIT = 2000;
const FINDING_LIMIT = 500;
const LINK_LIMIT = 5000;
const END_LIMIT = 2000;

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

export async function readDuplicatesSlice(sql: Sql, userId: string, now: Date): Promise<DoctorDuplicatesSlice> {
  void now;
  const [actions, proposals, findings, ends] = await Promise.all([
    sql<{ id: string; title: string; project_id: string; created_at: Date | null }[]>`
      SELECT ac.id::text AS id, ac.title, ac.project_id::text AS project_id, ac.created_at
      FROM actions ac
      JOIN projects p ON p.id = ac.project_id
      JOIN outcomes oc ON oc.id = p.outcome_id
      JOIN areas ar ON ar.id = oc.area_id
      WHERE ar.user_id = ${userId} AND p.status = 'active' AND ac.status IN ${sql([...DOCTOR_OPEN_ACTION_STATUSES])}
      ORDER BY ac.created_at ASC LIMIT ${ACTION_LIMIT}`,
    sql<{ id: string; source_id: string; proposal_type: string; title: string | null; created_at: Date | null }[]>`
      SELECT id::text AS id, source_id::text AS source_id, proposal_type, proposed_fields->>'title' AS title, created_at
      FROM captures
      WHERE user_id = ${userId} AND status = 'pending'
      ORDER BY created_at ASC LIMIT ${PROPOSAL_LIMIT}`,
    sql<{ item_ids: unknown }[]>`
      SELECT item_ids FROM plan_findings
      WHERE user_id = ${userId} AND status = 'open' AND check_name = 'duplicate_captures'
      LIMIT ${FINDING_LIMIT}`,
    sql<{ link_id: string; kind: string; link_status: string; end_type: string; end_id: string; end_state: string }[]>`
      WITH ends AS (
        SELECT * FROM (
          SELECT id, kind, status, from_type AS end_type, from_id AS end_id, created_at FROM plan_links
          WHERE user_id = ${userId} AND status IN ('confirmed','suggested')
          UNION ALL
          SELECT id, kind, status, to_type, to_id, created_at FROM plan_links
          WHERE user_id = ${userId} AND status IN ('confirmed','suggested')
        ) e ORDER BY created_at DESC LIMIT ${LINK_LIMIT}
      ), finished AS (
        SELECT e.id, e.kind, e.status, e.end_type, e.end_id, x.status::text AS end_state
        FROM ends e JOIN actions x ON e.end_type = 'action' AND x.id::text = e.end_id
          JOIN projects p ON p.id = x.project_id JOIN outcomes o ON o.id = p.outcome_id JOIN areas a ON a.id = o.area_id
        WHERE a.user_id = ${userId} AND x.status IN ('done','cancelled','archived')
        UNION ALL
        SELECT e.id, e.kind, e.status, e.end_type, e.end_id, p.status::text
        FROM ends e JOIN projects p ON e.end_type = 'project' AND p.id::text = e.end_id
          JOIN outcomes o ON o.id = p.outcome_id JOIN areas a ON a.id = o.area_id
        WHERE a.user_id = ${userId} AND p.status IN ('done','cancelled','archived')
        UNION ALL
        SELECT e.id, e.kind, e.status, e.end_type, e.end_id,
          CASE d.status::text WHEN 'completed' THEN 'done' ELSE d.status::text END
        FROM ends e JOIN deliverables d ON e.end_type = 'deliverable' AND d.id::text = e.end_id
          JOIN projects p ON p.id = d.project_id JOIN outcomes o ON o.id = p.outcome_id JOIN areas a ON a.id = o.area_id
        WHERE a.user_id = ${userId} AND d.status IN ('completed','cancelled','archived')
        UNION ALL
        SELECT e.id, e.kind, e.status, e.end_type, e.end_id, 'cancelled'
        FROM ends e JOIN commitments c ON e.end_type = 'commitment' AND c.id::text = e.end_id
        WHERE c.user_id = ${userId} AND c.status = 'cancelled'
        UNION ALL
        SELECT e.id, e.kind, e.status, e.end_type, e.end_id, 'archived'
        FROM ends e JOIN plan_subjects s ON e.end_type = 'subject' AND s.id = e.end_id
        WHERE s.user_id = ${userId} AND s.status = 'archived'
      )
      SELECT id::text AS link_id, kind, status AS link_status, end_type, end_id, end_state
      FROM finished ORDER BY kind, end_type, end_id LIMIT ${END_LIMIT}`
  ]);
  return {
    deadLinksTruncated: ends.length >= END_LIMIT,
    actions: actions.map((r) => ({ id: r.id, title: r.title, projectId: r.project_id, createdAt: iso(r.created_at) })),
    proposals: proposals.map((r) => ({
      id: r.id,
      sourceId: r.source_id,
      proposalType: r.proposal_type,
      title: r.title,
      createdAt: iso(r.created_at)
    })),
    openDuplicateFindingItemIds: findings.map((r) =>
      Array.isArray(r.item_ids) ? r.item_ids.filter((v): v is string => typeof v === "string") : []
    ),
    deadLinkEnds: ends.map((r) => ({
      linkId: r.link_id,
      kind: r.kind,
      linkStatus: r.link_status,
      endType: r.end_type,
      endId: r.end_id,
      endState: r.end_state
    }))
  };
}
