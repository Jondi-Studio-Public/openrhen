import { sessionCommandSchema } from "@openrhen/contracts";
import { requestAgent } from "@/server/agent-actor";
import { collectOccurredAtReport } from "@/server/occurred-at-report";
import { withRoute } from "@/server/logging";
import { getStateStore } from "@/server/persistence/state-store";

export const POST = withRoute("/api/commands/session", async (request, _context, log) => {
  const parsed = sessionCommandSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json({ error: "Session command validation failed.", issues: parsed.error.issues }, { status: 400 });
  log.setCommandType(parsed.data.type);
  const { value: state, report } = await collectOccurredAtReport(() => getStateStore().runSessionCommand(parsed.data));
  // An agent's write is snapshotted under its commandId (write-snapshot.ts); saying so lets the CLI journal it
  // for `rhen undo`, which posts that id to /api/commands/revert.
  return Response.json({
    state,
    ...(report ? { occurredAt: report } : {}),
    ...(requestAgent() !== null ? { revertible: parsed.data.commandId } : {})
  });
});
