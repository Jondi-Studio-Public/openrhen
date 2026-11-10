import { redeemDevicePairingSchema } from "@openrhen/contracts";
import { withRoute } from "@/server/logging";
import { OwnerCredentialError, redeemDevicePairing } from "@/server/owner-credential-store";
import { addressOf, agentRefusal, devicePool, fail, guard } from "@/server/devices/device-http";

/**
 * The phone redeems the secret from a QR for its own owner token (kind `token`, limited). The secret is the
 * credential: this route is exempt from the owner gate and checks it here. A wrong, spent or expired secret counts
 * against the shared failure throttle. Needs no `Origin`: the caller is an app, not a browser.
 */
export const POST = withRoute("/api/owner/devices/redeem", async (request, _context, log) => {
  const refused = agentRefusal();
  if (refused) return refused;
  const throttled = guard(request);
  if (throttled) return throttled;
  const parsed = redeemDevicePairingSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success)
    return Response.json({ error: "Redeem validation failed.", issues: parsed.error.issues }, { status: 400 });
  const pool = devicePool();
  if (pool instanceof Response) return pool;
  log.setCommandType("redeem_device_pairing");
  try {
    const minted = await redeemDevicePairing(pool, {
      secret: parsed.data.pairingSecret,
      name: parsed.data.name,
      device: { installId: parsed.data.installId, platform: parsed.data.platform },
      address: addressOf(request)
    });
    if (!minted) {
      fail(request);
      return Response.json(
        { error: "That pairing is not valid, has expired or was already used. Start again from a signed-in screen." },
        { status: 400 }
      );
    }
    return Response.json(
      { token: minted.secret, credential: minted.summary },
      { status: 201, headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof OwnerCredentialError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
});
