import { changesetCommandSchema } from "@openrhen/contracts";
import { requestAgent } from "@/server/agent-actor";
import { withRoute } from "@/server/logging";
import { getStateStore } from "@/server/persistence/state-store";

/**
 * One agent message of facts as one write: `preview` runs every command and rolls
 * them back, `apply` keeps them all or none. Each command is held to the token's scopes and hard floor as its own
 * route would hold it. An applied changeset whose writes kept row images answers `revertible`: undo takes the set.
 */
export const POST = withRoute("/api/commands/changeset", async (request, _context, log) => {
  const parsed = changesetCommandSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json({ error: "Changeset validation failed.", issues: parsed.error.issues }, { status: 400 });
  log.setCommandType(`changeset_${parsed.data.mode}`);
  const result = await getStateStore().runChangeset(parsed.data);
  const revertible =
    requestAgent() !== null && result.changesetId && result.items.some((item) => item.undoable)
      ? { revertible: result.changesetId }
      : {};
  return Response.json({ result, ...revertible });
});
