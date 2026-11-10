import type { RequirementWaiver } from "@openrhen/contracts";
import type { Sql } from "./sql-pool";

/**
 * "Do it without them" is one go at the work. The waiver stays stored until its safety expiry, but it stops
 * counting once the work it covers has been finished after it was said: an action marked done, or (for a
 * recurring action) an occurrence completed. Judged on read, so every path that completes work is covered
 * without each one having to remember to clear it, and a second occurrence of the same work is held again.
 */

export interface WorkCompletion {
  /** The latest time the action was completed (action or occurrence), ISO, if ever. */
  lastCompletedAt: string | null;
}

/** Pure: which waivers have been used up, given when each work item was last completed. */
export function consumedWaiverIds(
  waivers: Record<string, RequirementWaiver> | undefined,
  completions: ReadonlyMap<string, WorkCompletion>
): string[] {
  return Object.entries(waivers ?? {})
    .filter(([workId, waiver]) => {
      const done = completions.get(workId)?.lastCompletedAt;
      return done !== null && done !== undefined && Date.parse(done) >= Date.parse(waiver.setAt);
    })
    .map(([workId]) => workId);
}

export async function withoutConsumedWaivers<T extends { waivers?: Record<string, RequirementWaiver> | undefined }>(
  sql: Sql,
  situation: T
): Promise<T> {
  const ids = Object.keys(situation.waivers ?? {});
  if (!ids.length) return situation;
  const rows = await sql<{ id: string; last: Date | null }[]>`
    SELECT ac.id::text AS id,
      GREATEST(
        CASE WHEN ac.status::text = 'done' THEN COALESCE(ac.completed_at, ac.updated_at) END,
        (SELECT max(oc.completed_at) FROM action_occurrences oc WHERE oc.action_id = ac.id AND oc.status = 'completed')
      ) AS last
    FROM actions ac WHERE ac.id::text = ANY(${ids})`;
  const completions = new Map(
    rows.map((row) => [row.id, { lastCompletedAt: row.last ? row.last.toISOString() : null }])
  );
  const consumed = new Set(consumedWaiverIds(situation.waivers, completions));
  if (!consumed.size) return situation;
  const left = Object.fromEntries(Object.entries(situation.waivers ?? {}).filter(([id]) => !consumed.has(id)));
  const { waivers: _dropped, ...rest } = situation;
  return (Object.keys(left).length ? { ...rest, waivers: left } : rest) as T;
}
