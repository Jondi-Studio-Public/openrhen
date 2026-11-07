import { recordOutcome, recordShown, type OutcomeInput, type ShownInput } from "@openrhen/database";
import { changeLogActor } from "@/server/agent-actor";
import type { PoolSql, TxSql } from "./sql-pool";

/**
 * Appends one outcome to the Now offer log inside the caller's transaction (`recordOutcome`, platform/database). The
 * actor is the request's: an agent's name, `person` for the portal, `system` for a background writer. There is no
 * try/catch on purpose: a log insert that fails rolls the whole command back.
 */
export async function logOfferOutcome(tx: TxSql, userId: string, input: Omit<OutcomeInput, "actor">): Promise<void> {
  await recordOutcome(tx, userId, { ...input, actor: changeLogActor() ?? "person" });
}

/**
 * Appends one `shown` row in its own transaction (`recordShown`, platform/database). Used by the portal beacon, where a
 * failure is a 500 the client ignores, and by the handheld read path, which catches and swallows it.
 */
export async function logOfferShown(sql: PoolSql, userId: string, input: Omit<ShownInput, "actor">): Promise<boolean> {
  return sql.begin((tx) =>
    recordShown(tx, userId, { ...input, actor: changeLogActor() ?? "person" })
  ) as Promise<boolean>;
}
