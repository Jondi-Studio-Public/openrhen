import { approveDeviceCodeSchema } from "@openrhen/contracts";
import { withRoute } from "@/server/logging";
import { ownerOutcomeOf } from "@/server/owner-auth";
import { decideDeviceCode, lookupDeviceCode } from "@/server/owner-credential-store";
import { addressOf, agentRefusal, devicePool, fail, guard } from "@/server/devices/device-http";

/**
 * The owner types the code a device shows. With no `decision` this only looks the code up and answers who is asking
 * (name, platform, when), so the page can say "Approve only a code shown on a device in your hand." With `decision`
 * it approves or denies. The code is never in a link: the owner types it. A wrong code counts against the shared
 * failure throttle.
 */
export const POST = withRoute("/api/owner/devices/code/approve", async (request, _context, log) => {
  const refused = agentRefusal();
  if (refused) return refused;
  const throttled = guard(request);
  if (throttled) return throttled;
  const parsed = approveDeviceCodeSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success)
    return Response.json({ error: "Code validation failed.", issues: parsed.error.issues }, { status: 400 });
  const pool = devicePool();
  if (pool instanceof Response) return pool;
  const notFound = () => {
    fail(request);
    return Response.json({ error: "That code is not valid, has expired or was already used." }, { status: 404 });
  };
  if (!parsed.data.decision) {
    const pending = await lookupDeviceCode(pool, parsed.data.userCode);
    return pending ? Response.json({ pending }, { headers: { "cache-control": "no-store" } }) : notFound();
  }
  log.setCommandType(parsed.data.decision === "approve" ? "approve_device_code" : "deny_device_code");
  const decided = await decideDeviceCode(pool, parsed.data.userCode, parsed.data.decision, {
    actorId: ownerOutcomeOf(request)?.owner?.id ?? null,
    address: addressOf(request)
  });
  return decided
    ? Response.json({ decision: parsed.data.decision, device: decided }, { headers: { "cache-control": "no-store" } })
    : notFound();
});
