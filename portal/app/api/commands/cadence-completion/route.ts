import { recordCadenceCompletionCommandSchema } from "@openrhen/contracts";
import { revertibleAnswer } from "@/server/agent-revertible";
import { withRoute } from "@/server/logging";
import { getStateStore } from "@/server/persistence/state-store";

export const POST = withRoute("/api/commands/cadence-completion", async (request, _context, log) => {
  const parsed = recordCadenceCompletionCommandSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json(
      { error: "Cadence completion command validation failed.", issues: parsed.error.issues },
      { status: 400 }
    );
  log.setCommandType("record_cadence_completion");
  const state = await getStateStore().recordCadenceCompletion(parsed.data);
  return Response.json({ state, ...(await revertibleAnswer(parsed.data.commandId)) });
});
