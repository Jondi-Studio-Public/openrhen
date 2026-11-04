import { stretchCommandSchema } from "@openrhen/contracts";
import { withRoute } from "@/server/logging";
import { getStateStore } from "@/server/persistence/state-store";

/**
 * Answers a stretch offer: accept (work on the offered action despite the energy cut, for the offered minutes),
 * decline (skip that action until tomorrow) or decline_all (no stretches until tomorrow). The owner's browser posts
 * here; agent tokens are refused until the offer is readable by agents (`agent-routes.ts`). The server takes the
 * title and the minutes from the published plan run and sets the end itself, so a client-supplied `until` or
 * `minutes` is ignored. The answer names the command id as `revertible`: the owner's revert puts the old answers
 * back. Refusals are 409 with the exact next call; an unreadable body is a 400.
 */
export const POST = withRoute("/api/commands/stretch", async (request, _context, log) => {
  const body: unknown = await request.json().catch(() => null);
  const parsed = stretchCommandSchema.safeParse(
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? { commandId: crypto.randomUUID(), ...body }
      : body
  );
  if (!parsed.success)
    return Response.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid stretch answer.", issues: parsed.error.issues },
      { status: 400 }
    );
  log.setCommandType("stretch");
  const done = await getStateStore().runStretchCommand(parsed.data);
  return Response.json({ ...done, revertible: done.result.revertible });
});
