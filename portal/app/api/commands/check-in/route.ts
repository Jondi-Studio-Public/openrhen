import { checkInCommandSchema } from "@openrhen/contracts";
import { requestAgent } from "@/server/agent-actor";
import { withRoute } from "@/server/logging";
import { getStateStore } from "@/server/persistence/state-store";

export const POST = withRoute("/api/commands/check-in", async (request, _context, log) => {
  const parsed = checkInCommandSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid check-in answer." }, { status: 400 });
  log.setCommandType(parsed.data.type);
  const state = await getStateStore().runCheckInCommand(parsed.data);
  // Snapshotted for an agent (write-snapshot.ts); the CLI journals the id so `rhen undo` can revert it.
  return Response.json({ state, ...(requestAgent() !== null ? { revertible: parsed.data.commandId } : {}) });
});
