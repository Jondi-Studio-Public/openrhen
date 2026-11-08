import type { TxSql } from "./sql-pool";

/**
 * The per-person lock that keeps derived rows and their lineage from being orphaned. A derived row is written from
 * source rows it has just read; a delete removes source rows and the derived rows read from them. Without one lock
 * around both, the extractor can read a message, a delete can take the message and the derived rows that exist at
 * that moment, and the extractor then writes a derived row (and a lineage link to nothing) for a message that is gone.
 *
 * Transaction-scoped, so a crash or a rollback releases it and a pooled connection can never keep it. Re-entrant in
 * one session, so code that already holds it may call a function that takes it again.
 */
const lockKey = (userId: string) => `activity_store:${userId}`;

/** Waits for the lock. Taken at the start of each delete batch and of each derived write. */
export async function lockActivityUser(tx: TxSql, userId: string): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(userId)}, 0))`;
}

/** Takes the lock if it is free; false when another tick or a delete batch holds it. */
export async function tryLockActivityUser(tx: TxSql, userId: string): Promise<boolean> {
  const [row] = await tx<{ locked: boolean }[]>`
    SELECT pg_try_advisory_xact_lock(hashtextextended(${lockKey(userId)}, 0)) AS locked`;
  return row?.locked === true;
}
