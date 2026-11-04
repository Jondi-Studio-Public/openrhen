import { recordDisruptionCommandSchema } from "@openrhen/contracts";
import { withRoute } from "@/server/logging";
import { DisruptionIncompleteError } from "@/server/persistence/postgres/pulse-disruption";
import { getStateStore } from "@/server/persistence/state-store";

/**
 * Records, or with `end: true` ends, a disruption (the pulse on plan design note, sections 1 and 2): what he is doing
 * instead of the plan, until when, where, the contexts available and whether it takes all of him. A deviation stays on
 * plan only with all of it. The check-in "something else" flow, the CLI and the MCP tool all post here. It applies
 * directly for a token holding `write:check-in` (the route table in `agent-routes.ts`), never as a proposal, and the
 * answer names the command id as `revertible`. An incomplete one is a 422 that names each missing field.
 */
export const POST = withRoute("/api/commands/pulse-disruption", async (request, _context, log) => {
  const parsed = recordDisruptionCommandSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json({ error: "Disruption validation failed.", issues: parsed.error.issues }, { status: 400 });
  log.setCommandType("record_disruption");
  try {
    const done = await getStateStore().recordDisruption(parsed.data);
    return Response.json({ ...done, revertible: done.result.revertible });
  } catch (error) {
    if (error instanceof DisruptionIncompleteError) return Response.json(error.body, { status: 422 });
    throw error;
  }
});
