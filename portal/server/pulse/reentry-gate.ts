import { reentryRequiredBody } from "@openrhen/contracts";
import { readPulseReentryView, readReentryChoices } from "../persistence/postgres/reenter";
import { sqlPool, type PoolSql } from "../persistence/postgres/sql-pool";
import { databaseUrl } from "../runtime-env";

/**
 * The agent gate: while the pulse is `off/lapsed` every agent call is
 * refused with `reentryRequired`, whatever the tool: a read, a write, a check-in answer, a disruption. The refusal
 * carries the plain instruction, the pulse fields and what is missing, and no data and no directive. The way back is
 * `rhen_reenter`, and the read that tells an agent what to ask is exempt with it.
 *
 * Only an agent is held. The owner's own session is not gated here: the portal shows the re-entry sheet instead.
 * A pulse that cannot be read (no database, a read error) lets the call through: this guards freshness, not access.
 */

/** Routes an agent may still call while lapsed: re-entry itself and the read that says what it needs, the CLI's
    version check and bundle, health, and agent-time ingest (a hook posting timings, not plan data). */
const EXEMPT_ROUTES = new Set([
  "/api/commands/reenter",
  "/api/pulse/reentry",
  "/api/cli/version",
  "/api/cli/bundle",
  "/api/agent-sessions"
]);

export const REENTRY_REQUIRED_STATUS = 428;

/** The 428 the gate answers with for a lapsed pulse; a route that finds the lapse after the gate answers with the same body. */
export async function reentryRefusal(
  sql: PoolSql,
  view: NonNullable<Awaited<ReturnType<typeof readPulseReentryView>>>["view"]
): Promise<Response> {
  const choices = await readReentryChoices(sql).catch(() => undefined);
  return Response.json(
    reentryRequiredBody(
      view,
      choices && { places: choices.places, contexts: choices.contexts.map(({ id, name }) => ({ id, name })) }
    ),
    { status: REENTRY_REQUIRED_STATUS }
  );
}

export async function reentryGate(route: string, now: Date = new Date()): Promise<Response | null> {
  if (EXEMPT_ROUTES.has(route) || route.startsWith("/api/health/")) return null;
  const url = databaseUrl();
  if (!url) return null;
  try {
    const read = await readPulseReentryView(sqlPool(url), now);
    if (!read?.lapsed) return null;
    return await reentryRefusal(sqlPool(url), read.view);
  } catch (error) {
    console.error("reentry gate: could not read the pulse; letting the call through", error);
    return null;
  }
}
