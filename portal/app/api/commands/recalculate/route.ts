import { recalculateCommandSchema } from "@openrhen/contracts";
import { withRoute } from "@/server/logging";
import { getStateStore } from "@/server/persistence/state-store";

export const POST = withRoute("/api/commands/recalculate", async (request, _context, log) => {
  const parsed = recalculateCommandSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json(
      { error: "Recalculation command validation failed.", issues: parsed.error.issues },
      { status: 400 }
    );
  log.setCommandType(parsed.data.type);
  // The server's clock decides "now". A phone with a wrong date would otherwise store a plan
  // calculated for the wrong instant as the latest run; the body field stays only for compatibility.
  const command = { ...parsed.data, now: new Date().toISOString() };
  return Response.json({ state: await getStateStore().recalculate(command) });
});
