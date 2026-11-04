import { closeEntityCommandSchema } from "@openrhen/contracts";
import { revertibleAnswer } from "@/server/agent-revertible";
import { requestAgent } from "@/server/agent-actor";
import { withRoute } from "@/server/logging";
import { getStateStore } from "@/server/persistence/state-store";

/**
 * Archive or cancel one row, or restore it (`rhen_archive`, `rhen_cancel`). The body names the type, the id,
 * the verb of the tool used and `do: close | restore`. It never carries a child list: that exists only in a stored
 * proposal, which the applier passes to the store as a separate argument.
 */
export const POST = withRoute("/api/commands/close", async (request, _context, log) => {
  const parsed = closeEntityCommandSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json({ error: "Close command validation failed.", issues: parsed.error.issues }, { status: 400 });
  log.setCommandType("close_entity");
  // An agent's close needs a command id to be undone by; the CLI stamps one, a bare call gets one here.
  const command =
    requestAgent() !== null && !parsed.data.commandId
      ? { ...parsed.data, commandId: crypto.randomUUID() }
      : parsed.data;
  const { closed, state } = await getStateStore().closeEntity(command);
  return Response.json({ state, closed, ...(await revertibleAnswer(command.commandId)) });
});
