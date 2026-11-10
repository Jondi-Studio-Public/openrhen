import { pollDeviceCodeSchema } from "@openrhen/contracts";
import { withRoute } from "@/server/logging";
import { pollDeviceCode } from "@/server/owner-credential-store";
import { addressOf, agentRefusal, devicePool, fail, guard } from "@/server/devices/device-http";

/**
 * The device polls with its device code. Errors use RFC 8628's names (`authorization_pending`, `slow_down`,
 * `expired_token`, `access_denied`) with HTTP 400; the device waits `interval` seconds between polls. An approved code
 * answers `{ token, credential }` once. The device code is the credential, so this route is exempt from the owner gate.
 */
export const POST = withRoute("/api/owner/devices/code/token", async (request, _context, log) => {
  const refused = agentRefusal();
  if (refused) return refused;
  const throttled = guard(request);
  if (throttled) return throttled;
  const parsed = pollDeviceCodeSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 400 });
  const pool = devicePool();
  if (pool instanceof Response) return pool;
  log.setCommandType("poll_device_code");
  const result = await pollDeviceCode(pool, parsed.data.deviceCode, addressOf(request));
  if (result.kind === "error") {
    if (result.error === "expired_token") fail(request);
    return Response.json({ error: result.error }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  return Response.json(
    { token: result.secret, credential: result.summary },
    { headers: { "cache-control": "no-store" } }
  );
});
