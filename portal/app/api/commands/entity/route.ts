import { planningEntityCommandSchema } from "@openrhen/contracts";
import { revertibleAnswer } from "@/server/agent-revertible";
import { withRoute } from "@/server/logging";
import { getStateStore } from "@/server/persistence/state-store";

export const POST = withRoute("/api/commands/entity", async (request, _context, log) => {
  const parsed = planningEntityCommandSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json({ error: "Entity command validation failed.", issues: parsed.error.issues }, { status: 400 });
  log.setCommandType(`${parsed.data.type}:${parsed.data.entityType}`);
  const state = await getStateStore().saveEntity(parsed.data);
  // An agent's save that changed rows is snapshotted (write-snapshot.ts); the CLI journals the id so
  // `rhen undo` can revert it.
  return Response.json({ state, ...(await revertibleAnswer(parsed.data.commandId)) });
});
