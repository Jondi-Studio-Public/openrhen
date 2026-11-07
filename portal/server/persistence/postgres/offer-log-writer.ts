import { recordOutcome, type OutcomeInput } from "@openrhen/database";
import { changeLogActor } from "@/server/agent-actor";
import type { TxSql } from "./sql-pool";

/**
 * Appends one outcome to the Now offer log inside the caller's transaction (`recordOutcome`, platform/database). The
 * actor is the request's: an agent's name, `person` for the portal, `system` for a background writer. There is no
 * try/catch on purpose: a log insert that fails rolls the whole command back.
 */
export async function logOfferOutcome(tx: TxSql, userId: string, input: Omit<OutcomeInput, "actor">): Promise<void> {
  await recordOutcome(tx, userId, { ...input, actor: changeLogActor() ?? "person" });
}
