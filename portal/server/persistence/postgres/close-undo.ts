import { UNDO_WINDOW_HOURS } from "@openrhen/contracts";
import { changeLogActor } from "@/server/agent-actor";
import type { Sql } from "./sql-pool";

/**
 * Whether `undoOfCommandId` names this actor's own create of this very row (archive-removals design section 3, plan
 * WP4). All of it is read from the write ledger, never from what the caller says:
 * - the write is the same user's and the same actor's (a person's write has no actor, so the owner's CLI undoes its own);
 * - it created the row (`evidence.created`, set by the save handlers) and was not an owner-confirmed proposal;
 * - it is less than `UNDO_WINDOW_HOURS` old;
 * - nobody else has written the row since: a later ledger row for the same row must be the same actor's and not a
 *   confirmation, so the owner's edit (every portal write) ends the exemption.
 * The caller also needs the row's current version to equal the version the agent sent, and that version must be the
 * one the create left plus one for each of the agent's own later writes: an edit that wrote no ledger row of the row's
 * type (so it is invisible above) still moved the version, and ends the exemption.
 */
export async function verifyUndoOfCreate(
  tx: Sql,
  userId: string,
  entityType: string,
  storedId: string,
  undoOfCommandId: string,
  /** The row's version now. An edit through a path that leaves no ledger row of the row's type (an activity, a session, a planner write) moves it. */
  currentVersion: number,
  actor: string | null = changeLogActor()
): Promise<boolean> {
  // A deliverable's steps are actions of their own that a close of the deliverable alone would leave planned: its
  // close is an ordinary, braked one (include-children), never an undo.
  if (entityType === "deliverable") return false;
  const rows = await tx<{ ok: number }[]>`
    SELECT 1 AS ok
    FROM write_rows r
    JOIN writes w ON w.id = r.write_id
    WHERE w.id = ${undoOfCommandId}
      AND w.user_id = ${userId}
      AND w.actor IS NOT DISTINCT FROM ${actor}
      AND r.user_id = ${userId}
      AND r.entity_type = ${entityType}
      AND r.entity_id = ${storedId}
      AND r.operation = 'save'
      AND r.evidence->>'created' = 'true'
      AND r.evidence->>'confirmedBy' IS NULL
      AND r.created_at > now() - make_interval(hours => ${UNDO_WINDOW_HOURS})
      AND ${currentVersion}::int = COALESCE((r.evidence->>'createdVersion')::int, 1) + (
        SELECT COUNT(DISTINCT own.write_id)
        FROM write_rows own
        WHERE own.user_id = ${userId}
          AND own.entity_type = ${entityType}
          AND own.entity_id = ${storedId}
          AND own.write_id <> r.write_id
          AND own.created_at >= r.created_at
      )
      AND NOT EXISTS (
        SELECT 1
        FROM write_rows later
        JOIN writes lw ON lw.id = later.write_id
        WHERE later.user_id = ${userId}
          AND later.entity_type = ${entityType}
          AND later.entity_id = ${storedId}
          AND later.write_id <> r.write_id
          AND later.created_at >= r.created_at
          AND (lw.actor IS DISTINCT FROM ${actor} OR later.evidence->>'confirmedBy' IS NOT NULL)
      )
    LIMIT 1`;
  return rows.length > 0;
}
