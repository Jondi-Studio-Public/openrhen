import { wakeCommandSchema } from "@openrhen/contracts";
import { requestAgent } from "@/server/agent-actor";
import { withRoute } from "@/server/logging";
import { getStateStore } from "@/server/persistence/state-store";

/**
 * Settles last night around when the person woke. An agent with the
 * sleep log's scope (`write:entity:sleep_log_entry`) applies it directly: it records what happened, so there is no
 * proposal. `wake` says which of the three things it did, and is absent when the command id had already been applied.
 * An agent's wake is undoable: `revertible` names the write the portal kept the rows of, so `rhen undo` sends
 * it to `/api/commands/revert` and one undo reverses the whole wake.
 */
export const POST = withRoute("/api/commands/wake", async (request, _context, log) => {
  const parsed = wakeCommandSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid wake command.", issues: parsed.error.issues },
      { status: 400 }
    );
  log.setCommandType(parsed.data.type);
  const { state, wake } = await getStateStore().runWakeCommand(parsed.data);
  return Response.json({
    state,
    ...(wake ? { wake } : {}),
    ...(requestAgent() !== null ? { revertible: parsed.data.commandId } : {})
  });
});
