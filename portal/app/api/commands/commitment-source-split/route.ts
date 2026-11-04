import { splitCommitmentSourceCommandSchema } from "@openrhen/contracts";
import { withRoute } from "@/server/logging";
import { getStateStore } from "@/server/persistence/state-store";

/** **Not the same event**: takes one secondary source off a commitment as a commitment of its own. */
export const POST = withRoute("/api/commands/commitment-source-split", async (request, _context, log) => {
  const parsed = splitCommitmentSourceCommandSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json({ error: "Source split validation failed.", issues: parsed.error.issues }, { status: 400 });
  log.setCommandType("split_commitment_source");
  return Response.json({ state: await getStateStore().splitCommitmentSource(parsed.data) });
});
