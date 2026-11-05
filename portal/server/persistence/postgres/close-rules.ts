import { InvalidCommandError } from "./command-errors";
import type { Sql } from "./sql-pool";

/**
 * Rules that apply when a record is archived, whichever command does it (a save that sets the status, or the close
 * command), so the two cannot drift apart.
 */

/**
 * Sleep and every return leg point at the owner's home location, so it cannot quietly stop existing: the owner
 * chooses another home in Settings first. Throws when `contextId` (the stored slug) is that home.
 */
export async function assertNotHomeLocation(
  tx: Sql,
  userId: string,
  contextId: string,
  shownId: string
): Promise<void> {
  const home = await tx<
    { home_location_id: string | null }[]
  >`SELECT home_location_id FROM user_preferences WHERE user_id=${userId}`;
  if (home[0]?.home_location_id === contextId)
    throw new InvalidCommandError(
      `Context "${shownId}" is the owner's home location, and sleep and every return leg point at it, so it cannot be archived. ` +
        "Only the owner can choose another home (in Settings, under Places); tell the person, then archive this one once they have."
    );
}

/**
 * A person that open work still needs (`pete@with` or `pete@remote` on an action or a step) cannot be archived out
 * from under it: the work would wait on someone who no longer exists, and nothing would say why. The owner decides
 * first, work by work: drop the requirement, swap the person, or let it go ahead without them. A bare requirement on
 * the contact keeps its old meaning and is not checked here.
 */
export async function assertNotRequiredByOpenWork(
  tx: Sql,
  userId: string,
  contextId: string,
  shownId: string
): Promise<void> {
  const keys = [`${contextId}@with`, `${contextId}@remote`];
  const rows = await tx<{ id: string; title: string; key: string }[]>`
    SELECT DISTINCT ac.id::text AS id, ac.title, req.context_key AS key
    FROM action_requirements req
    JOIN action_requirement_pathways rp ON rp.id=req.pathway_id
    JOIN actions ac ON ac.id=rp.action_id
    JOIN projects p ON p.id=ac.project_id
    JOIN outcomes o ON o.id=p.outcome_id
    JOIN areas ar ON ar.id=o.area_id
    WHERE ar.user_id=${userId} AND req.context_key = ANY(${keys})
      AND ac.status NOT IN ('done','cancelled','archived')
    ORDER BY ac.title LIMIT 6`;
  if (!rows.length) return;
  const shown = rows.map((row) => `"${row.title}" (${row.id}, needs ${row.key})`).join("; ");
  throw new InvalidCommandError(
    `Context "${shownId}" cannot be archived: open work still needs this person: ${shown}${rows.length === 6 ? " and possibly more" : ""}. ` +
      "Nothing was archived. Ask the owner what to do for each: remove the requirement (rhen_save action with requires without them), " +
      "swap in someone else, or let it go ahead without them; then archive. Do not archive the person to make the work disappear.",
    {
      nextCall: {
        tool: "rhen_search",
        arguments: { query: shownId },
        note: "finds the work that names this person; then change its requires before archiving"
      }
    }
  );
}
