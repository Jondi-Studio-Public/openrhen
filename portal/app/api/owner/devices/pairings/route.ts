import { startDevicePairingSchema, type DevicePairingPayload } from "@openrhen/contracts";
import { withRoute } from "@/server/logging";
import { ownerOutcomeOf } from "@/server/owner-auth";
import { OwnerCredentialError, startDevicePairing } from "@/server/owner-credential-store";
import { addressOf, agentRefusal, devicePool } from "@/server/devices/device-http";
import { pairingOrigin } from "@/server/devices/pairing-origin";

/**
 * The signed-in owner asks for a QR to add a phone. Answers the text the QR holds: the portal's public origin
 * (`PORTAL_PUBLIC_URL`, or the https address the owner typed for this one QR; never the request's Host) and a
 * one-time pairing secret that lasts ten minutes and works once. Owner-only: under `require` the wrapper has already
 * demanded an owner credential and refused a limited one (`owner-admin`); under `off` or `shadow` any caller that is
 * not an agent may ask, as with enrol.
 */
export const POST = withRoute("/api/owner/devices/pairings", async (request, _context, log) => {
  const refused = agentRefusal();
  if (refused) return refused;
  const parsed = startDevicePairingSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success)
    return Response.json({ error: "Pairing validation failed.", issues: parsed.error.issues }, { status: 400 });
  const origin = pairingOrigin(parsed.data.origin);
  if (!origin.ok)
    return Response.json(
      { error: origin.error, ...(origin.needsOrigin ? { needsOrigin: true } : {}) },
      { status: origin.status }
    );
  const pool = devicePool();
  if (pool instanceof Response) return pool;
  log.setCommandType("start_device_pairing");
  try {
    const pairing = await startDevicePairing(pool, {
      actorId: ownerOutcomeOf(request)?.owner?.id ?? null,
      address: addressOf(request)
    });
    const payload: DevicePairingPayload = { v: 1, origin: origin.origin, secret: pairing.secret };
    return Response.json(
      {
        pairingId: pairing.id,
        origin: origin.origin,
        host: origin.host,
        payload: JSON.stringify(payload),
        expiresAt: pairing.expiresAt.toISOString()
      },
      { status: 201, headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof OwnerCredentialError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }
});
