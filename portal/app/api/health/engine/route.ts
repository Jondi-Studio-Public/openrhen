import { detailedHealth } from "@/server/health-detail";
import { withRoute } from "@/server/logging";
import { probeEngine } from "@/server/diagnostics/engine-probe";

export const GET = withRoute(
  "/api/health/engine",
  async (request) => {
    const probe = await probeEngine();
    // An anonymous caller under owner auth learns only reachable / not, never versions, latency or error text.
    const body = (await detailedHealth(request)) ? probe : { reachable: probe.reachable };
    return Response.json(body, { status: probe.reachable ? 200 : 503 });
  },
  { probe: true }
);
