import { activityCommandSchema } from "@openrhen/contracts";
import { revertibleAnswer } from "@/server/agent-revertible";
import { collectOccurredAtReport } from "@/server/occurred-at-report";
import { withRoute } from "@/server/logging";
import { getStateStore } from "@/server/persistence/state-store";

export const POST = withRoute("/api/commands/activity", async (request, _context, log) => {
  const parsed = activityCommandSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid activity command." }, { status: 400 });
  log.setCommandType(parsed.data.type);
  const { value: state, report } = await collectOccurredAtReport(() => getStateStore().runActivityCommand(parsed.data));
  return Response.json({
    state,
    ...(report ? { occurredAt: report } : {}),
    ...(await revertibleAnswer(parsed.data.commandId))
  });
});
