import { reenterCommandSchema } from "@openrhen/contracts";
import { withRoute } from "@/server/logging";
import { ReentryIncompleteError } from "@/server/persistence/postgres/reenter";
import { reentryLook } from "@/server/pulse/reentry-look";
import { getStateStore } from "@/server/persistence/state-store";

/**
 * Ends a lapsed pulse: the three facts and a settlement of the window the
 * pulse lost, all or nothing. The person's sheet, the CLI and the MCP tool all post here. It applies directly for a
 * token holding `write:catch-up` (the route table in `agent-routes.ts`), never as a proposal, and the answer names the
 * command id as `revertible`: `rhen undo` or the owner's revert puts the lapsed pulse and the unsettled items
 * back. An incomplete answer is a 422 that names each missing fact and unreviewed item.
 */
export const GET = withRoute("/api/commands/reenter", (request) => reentryLook(request));

export const POST = withRoute("/api/commands/reenter", async (request, _context, log) => {
  const body: unknown = await request.json().catch(() => null);
  // An empty or partial answer still gets the structured refusal naming what is missing, so a command id is not
  // something the caller must have to ask what to answer.
  const parsed = reenterCommandSchema.safeParse(
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? { commandId: crypto.randomUUID(), ...body }
      : body
  );
  if (!parsed.success)
    return Response.json({ error: "Re-entry validation failed.", issues: parsed.error.issues }, { status: 400 });
  log.setCommandType("reenter");
  try {
    const done = await getStateStore().reenter(parsed.data);
    return Response.json({ ...done, revertible: done.result.revertible });
  } catch (error) {
    if (error instanceof ReentryIncompleteError) return Response.json(error.body, { status: 422 });
    throw error;
  }
});
