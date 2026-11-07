import { alreadyClosed, notFound } from "./command-errors";
import type { InvalidCommandError } from "./command-errors";
import type { TxSql } from "./sql-pool";

/**
 * The refusal for a session id that matched no OPEN session. A session that exists but already ended (a finish repeated
 * after the first landed, or a stale client) is told apart from an id that never existed: the first names when it
 * ended, the second says the id may be wrong.
 */
export async function noOpenSession(
  tx: TxSql,
  userId: string,
  sessionId: string,
  what?: string
): Promise<InvalidCommandError> {
  const ended = await tx<{ ended_at: Date }[]>`
    SELECT ended_at FROM sessions WHERE id=${sessionId} AND user_id=${userId} AND ended_at IS NOT NULL
  `;
  if (ended[0])
    return alreadyClosed("session", sessionId, `ended (at ${ended[0].ended_at.toISOString()})`, {
      tool: "rhen_status",
      arguments: {},
      note: "shows what is open now; start a new session from there if more work is planned"
    });
  return notFound("session", sessionId, what);
}
