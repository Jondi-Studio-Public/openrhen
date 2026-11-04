import { confirmProjectWantedCommandSchema } from "@openrhen/contracts";
import { revertibleAnswer } from "@/server/agent-revertible";
import { requestAgent } from "@/server/agent-actor";
import { withRoute } from "@/server/logging";
import { getStateStore } from "@/server/persistence/state-store";

/** "Confirm project still wanted" (the weekly review's Keep): the only route that writes `projects.last_reviewed_at`. */
export const POST = withRoute("/api/commands/project-review", async (request, _context, log) => {
  const parsed = confirmProjectWantedCommandSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json(
      { error: "Project review command validation failed.", issues: parsed.error.issues },
      { status: 400 }
    );
  log.setCommandType("confirm_project_wanted");
  // An agent's review needs a command id to be undone by; the CLI stamps one, a bare call gets one here.
  const command =
    requestAgent() !== null && !parsed.data.commandId
      ? { ...parsed.data, commandId: crypto.randomUUID() }
      : parsed.data;
  const state = await getStateStore().confirmProjectWanted(command);
  return Response.json({ state, ...(await revertibleAnswer(command.commandId)) });
});
