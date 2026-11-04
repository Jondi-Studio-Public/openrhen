import type { PortalState } from "@/state/portal-state";
import { CommittedReadFailedError } from "./command-errors";
import { readPortalState } from "./state-read";
import type { Sql } from "./sql-pool";

/**
 * The state a write answers with, read after its transaction has committed (or after finding its receipt,
 * which means it committed earlier). The write is saved whatever happens here, so a failed read (a pool blip,
 * a statement timeout) must not surface as a 500 that tells the caller nothing landed: a retry without the
 * command id would then save a create twice. It becomes a `CommittedReadFailedError`, which the route answers
 * 503 with `committed: true`; repeating the command with the same id replays the receipt and reads again.
 */
export async function readStateAfterCommit(sql: Sql): Promise<PortalState> {
  try {
    return (await readPortalState(sql))!;
  } catch (cause) {
    throw new CommittedReadFailedError(cause);
  }
}
