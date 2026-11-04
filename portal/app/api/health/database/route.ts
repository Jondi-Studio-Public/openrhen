import { detailedHealth } from "@/server/health-detail";
import { redact, withRoute } from "@/server/logging";
import { getStateStore } from "@/server/persistence/state-store";

export const GET = withRoute(
  "/api/health/database",
  async (request, _context, log) => {
    try {
      const health = await getStateStore().health();
      if (await detailedHealth(request)) return Response.json(health);
      return Response.json({ connected: true });
    } catch (error) {
      log.setError(error);
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "UNKNOWN";
      const pending = code === "MIGRATIONS_PENDING";
      if (!(await detailedHealth(request)))
        // No version, error text or driver code for an anonymous caller; the pending flag keeps the UI honest.
        return Response.json({ connected: pending, ...(pending ? { errorCode: code } : {}) }, { status: 503 });
      const detail = redact(error instanceof Error ? error.message : "Unknown database error").slice(0, 240);
      if (pending) {
        // The connection is fine; the schema is behind the image. 503 still fails the deploy gate.
        return Response.json(
          { connected: true, provider: "postgresql", version: "Unavailable", latencyMs: 0, errorCode: code, detail },
          { status: 503 }
        );
      }
      return Response.json(
        { connected: false, provider: "postgresql", version: "Unavailable", latencyMs: 0, errorCode: code, detail },
        { status: 503 }
      );
    }
  },
  { probe: true }
);
