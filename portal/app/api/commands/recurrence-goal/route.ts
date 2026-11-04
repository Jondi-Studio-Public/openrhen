import { endRecurrenceGoalCommandSchema } from "@openrhen/contracts";
import { revertibleAnswer } from "@/server/agent-revertible";
import { withRoute } from "@/server/logging";
import { getStateStore } from "@/server/persistence/state-store";

export const POST = withRoute("/api/commands/recurrence-goal", async (request, _context, log) => {
  const parsed = endRecurrenceGoalCommandSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json(
      { error: "Recurrence goal command validation failed.", issues: parsed.error.issues },
      { status: 400 }
    );
  log.setCommandType("end_recurrence_goal");
  const state = await getStateStore().endRecurrenceGoal(parsed.data);
  return Response.json({ state, ...(await revertibleAnswer(parsed.data.commandId)) });
});
