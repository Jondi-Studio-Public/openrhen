import { revertCommandSchema } from "@openrhen/contracts";
import { withRoute } from "@/server/logging";
import { getStateStore } from "@/server/persistence/state-store";

/**
 * Undoes or redoes an agent's earlier session, check-in or catch-up write from the row snapshot kept for it
 *. A row changed since refuses with 409 unless `force`.
 */
export const POST = withRoute("/api/commands/revert", async (request, _context, log) => {
  const parsed = revertCommandSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid revert command." }, { status: 400 });
  log.setCommandType(`revert_${parsed.data.direction}`);
  return Response.json({ state: await getStateStore().runRevertCommand(parsed.data) });
});
