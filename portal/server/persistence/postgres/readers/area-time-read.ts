import type { Sql } from "../sql-pool";

/** Recorded minutes one project received inside a window. */
export interface ProjectRecordedMinutes {
  projectId: string;
  minutes: number;
}

/**
 * Recorded time per project since `since`, for Review's area balance (a review signal,
 * never a ranking term). Time is the sum of session segments — the same single timer History and
 * the deliverable workspace read, so a minute is never counted twice — clipped to the window, with a
 * still-open segment counted up to `now`. A segment belongs to the project of the deliverable step it
 * names, else the session's action, else the session's deliverable. Sleep, routine and commitment
 * sessions name none of those, so they belong to no area and are left out.
 */
export async function readProjectRecordedMinutes(
  sql: Sql,
  userId: string,
  since: Date,
  now: Date
): Promise<ProjectRecordedMinutes[]> {
  const rows = await sql<{ project_id: string; seconds: number }[]>`
    SELECT COALESCE(step.project_id, ac.project_id, dl.project_id) AS project_id,
      SUM(EXTRACT(EPOCH FROM (LEAST(COALESCE(ss.ended_at, ${now}), ${now}) - GREATEST(ss.started_at, ${since}))))::int AS seconds
    FROM session_segments ss
    JOIN sessions se ON se.id = ss.session_id
    LEFT JOIN actions step ON step.id = ss.step_id
    LEFT JOIN actions ac ON ac.id = se.action_id
    LEFT JOIN deliverables dl ON se.target_type = 'deliverable' AND dl.id = se.target_id
    WHERE se.user_id = ${userId}
      AND COALESCE(ss.ended_at, ${now}) > ${since}
      AND ss.started_at < ${now}
      AND COALESCE(step.project_id, ac.project_id, dl.project_id) IS NOT NULL
    GROUP BY 1
  `;
  return rows
    .map((row) => ({ projectId: row.project_id, minutes: Math.round(row.seconds / 60) }))
    .filter((row) => row.minutes > 0);
}
