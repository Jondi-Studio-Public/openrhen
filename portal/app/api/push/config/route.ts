import { withRoute } from "@/server/logging";
import { fetchVapidPublicKey } from "@/server/push/push-proxy-client";

/**
 * Whether push is available and the public key to subscribe with (the leave by push design note,
 * "Portal routes"). The portal holds no VAPID credentials of its own — this is a pass-through to the
 * outbound proxy's `GET /push/vapid-public-key`.
 */
export const GET = withRoute("/api/push/config", async () => {
  const publicKey = await fetchVapidPublicKey().catch(() => null);
  return Response.json({ available: publicKey !== null, publicKey });
});
