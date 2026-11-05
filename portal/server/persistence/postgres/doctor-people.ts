import type { DoctorPeopleSlice } from "@openrhen/contracts";
import { parseCurrentSituation } from "./current-situation";
import { readConditions } from "./readers/conditions";
import type { Sql } from "./sql-pool";

/**
 * The doctor's person-requirement reader: the plain slice `doctorPeopleItems` checks. User-scoped and bounded.
 * Only open work that states a tagged (`@with` / `@remote`) requirement is read; its deadline is its own or the
 * earlier of its project's. Writes nothing.
 */

const LIMIT = 500;

export async function readPeopleSlice(sql: Sql, userId: string, now: Date): Promise<DoctorPeopleSlice> {
  const [definitions, prefs, user, commitments, work] = await Promise.all([
    readConditions(sql, userId),
    sql<{ current_situation: unknown }[]>`SELECT current_situation FROM user_preferences WHERE user_id=${userId}`,
    sql<{ timezone: string }[]>`SELECT timezone FROM users WHERE id=${userId}`,
    sql<
      {
        id: string;
        title: string;
        starts_at: Date;
        ends_at: Date;
        status: string;
        contact_id: string | null;
        attendance: string | null;
      }[]
    >`SELECT id, title, starts_at, ends_at, status::text AS status, contact_id, attendance::text AS attendance
      FROM commitments WHERE user_id=${userId} AND ends_at >= ${now} - interval '1 day'
      ORDER BY starts_at LIMIT ${LIMIT}`,
    sql<
      {
        id: string;
        title: string;
        pathway_id: string;
        context_key: string;
        deadline_at: Date | null;
        project_deadline: Date | null;
        deliverable_deadline: Date | null;
      }[]
    >`SELECT ac.id::text AS id, ac.title, rp.id::text AS pathway_id, req.context_key, ac.deadline_at,
        LEAST(p.external_deadline_at, p.internal_deadline_at) AS project_deadline,
        LEAST(d.external_deadline_at, d.internal_deadline_at) AS deliverable_deadline
      FROM actions ac
      LEFT JOIN deliverables d ON d.id=ac.deliverable_id
      JOIN projects p ON p.id=ac.project_id AND p.status='active'
      JOIN outcomes o ON o.id=p.outcome_id JOIN areas a ON a.id=o.area_id AND a.user_id=${userId}
      JOIN action_requirement_pathways rp ON rp.action_id=ac.id
      JOIN action_requirements req ON req.pathway_id=rp.id
      WHERE ac.status::text NOT IN ('done','cancelled','archived')
        AND ac.id IN (SELECT rp2.action_id FROM action_requirement_pathways rp2
                      JOIN action_requirements r2 ON r2.pathway_id=rp2.id WHERE r2.context_key LIKE '%@%')
      ORDER BY ac.id, rp.sort_order, req.context_key LIMIT ${LIMIT * 4}`
  ]);

  const byWork = new Map<
    string,
    { id: string; title: string; deadlineAt: string | null; pathways: Map<string, string[]> }
  >();
  for (const row of work) {
    const earliest = [row.deadline_at, row.project_deadline, row.deliverable_deadline].filter(
      (d): d is Date => d !== null
    );
    const deadline = earliest.length ? new Date(Math.min(...earliest.map((d) => d.getTime()))).toISOString() : null;
    const entry = byWork.get(row.id) ?? { id: row.id, title: row.title, deadlineAt: deadline, pathways: new Map() };
    entry.pathways.set(row.pathway_id, [...(entry.pathways.get(row.pathway_id) ?? []), row.context_key]);
    byWork.set(row.id, entry);
  }
  return {
    situation: parseCurrentSituation(prefs[0]?.current_situation) as DoctorPeopleSlice["situation"],
    definitions: definitions as unknown as DoctorPeopleSlice["definitions"],
    commitments: commitments.map((row) => ({
      id: row.id,
      title: row.title,
      startsAt: row.starts_at.toISOString(),
      endsAt: row.ends_at.toISOString(),
      status: row.status,
      ...(row.contact_id ? { contactId: row.contact_id } : {}),
      ...(row.attendance ? { attendance: row.attendance } : {})
    })),
    timeZone: user[0]?.timezone ?? "UTC",
    work: [...byWork.values()].map((entry) => ({
      id: entry.id,
      title: entry.title,
      deadlineAt: entry.deadlineAt,
      pathways: [...entry.pathways].map(([id, contextIds]) => ({ id, contextIds }))
    }))
  };
}
