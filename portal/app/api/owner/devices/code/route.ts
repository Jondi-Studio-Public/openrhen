import { DEVICE_PAIRING_MINUTES, requestDeviceCodeSchema } from "@openrhen/contracts";
import { withRoute } from "@/server/logging";
import { OwnerCredentialError, startDeviceCode } from "@/server/owner-credential-store";
import { addressOf, agentRefusal, codeStartThrottle, devicePool, tooManyAttempts } from "@/server/devices/device-http";

/**
 * A device with no signed-in screen to hand asks for a code (the shape of RFC 8628). Anyone who can reach the portal
 * may ask, so each address gets a few a minute and only so many codes can wait at once; the code does nothing until
 * the owner types it on the Devices page and approves. There is no verification link: the owner types the code.
 */
export const POST = withRoute("/api/owner/devices/code", async (request, _context, log) => {
  const refused = agentRefusal();
  if (refused) return refused;
  const address = addressOf(request);
  const wait = codeStartThrottle.retryAfter(address);
  if (wait > 0) return tooManyAttempts(wait);
  const parsed = requestDeviceCodeSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success)
    return Response.json({ error: "Code validation failed.", issues: parsed.error.issues }, { status: 400 });
  const pool = devicePool();
  if (pool instanceof Response) return pool;
  codeStartThrottle.fail(address);
  log.setCommandType("start_device_code");
  try {
    const started = await startDeviceCode(pool, {
      name: parsed.data.name,
      device: { installId: parsed.data.installId, platform: parsed.data.platform },
      address
    });
    return Response.json(
      {
        deviceCode: started.deviceCode,
        userCode: started.userCode,
        expiresIn: DEVICE_PAIRING_MINUTES * 60,
        interval: started.interval
      },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof OwnerCredentialError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
});
