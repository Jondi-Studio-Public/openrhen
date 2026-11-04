import { saveCommitmentRecurrenceRuleCommandSchema } from "@openrhen/contracts";
import { revertibleAnswer } from "@/server/agent-revertible";
import { requestAgent } from "@/server/agent-actor";
import { withRoute } from "@/server/logging";
import { getStateStore } from "@/server/persistence/state-store";

export const POST = withRoute("/api/commands/commitment-recurrence", async (request, _context, log) => {
  const parsed = saveCommitmentRecurrenceRuleCommandSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json(
      { error: "Recurring commitment command validation failed.", issues: parsed.error.issues },
      { status: 400 }
    );
  log.setCommandType("save_commitment_recurrence_rule");
  const command =
    requestAgent() !== null && !parsed.data.commandId
      ? { ...parsed.data, commandId: crypto.randomUUID() }
      : parsed.data;
  const state = await getStateStore().saveCommitmentRecurrenceRule(command);
  return Response.json({ state, ...(await revertibleAnswer(command.commandId)) });
});
