import { saveProjectCommandSchema } from "@openrhen/contracts";
import { revertibleAnswer } from "@/server/agent-revertible";
import { requestAgent } from "@/server/agent-actor";
import { withRoute } from "@/server/logging";
import { getStateStore } from "@/server/persistence/state-store";

export const POST = withRoute("/api/commands/project", async (request, _context, log) => {
  const parsed = saveProjectCommandSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json({ error: "Project command validation failed.", issues: parsed.error.issues }, { status: 400 });
  log.setCommandType("save_project");
  // An agent's save needs a command id to be undone by; the CLI stamps one, a bare call gets one here.
  const command =
    requestAgent() !== null && !parsed.data.commandId
      ? { ...parsed.data, commandId: crypto.randomUUID() }
      : parsed.data;
  const state = await getStateStore().saveProject(command);
  return Response.json({ state, ...(await revertibleAnswer(command.commandId)) });
});
