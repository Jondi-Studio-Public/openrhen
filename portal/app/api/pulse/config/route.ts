import { withRoute } from "@/server/logging";
import { fetchPulsePublishConfig } from "@/server/pulse/pulse-publish-client";

/**
 * `GET /api/pulse/config`: whether a tracker
 * URL is configured and its host, for Settings → Pulse's "Sending to <host>" / "No tracker URL set"
 * line. The portal holds neither the URL nor the secret — this is a pass-through to the outbound
 * proxy's own `GET /pulse/config`.
 */
export const GET = withRoute("/api/pulse/config", async () => {
  const config = await fetchPulsePublishConfig();
  return Response.json(config);
});
