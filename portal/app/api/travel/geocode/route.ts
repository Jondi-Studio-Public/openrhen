import { geocodeRequestSchema } from "@openrhen/contracts";
import { redact, withRoute } from "@/server/logging";
import { geocodeQuery } from "@/integrations/travel/travel-proxy-client";

/** Turns a typed place name into coordinates, so nobody has to enter a latitude by hand. */
export const POST = withRoute("/api/travel/geocode", async (request, _context, log) => {
  const body = await request.json().catch(() => null);
  const parsed = geocodeRequestSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Enter a place to look up." }, { status: 400 });
  try {
    return Response.json(await geocodeQuery(parsed.data.query));
  } catch (error) {
    log.setError(error);
    return Response.json(
      { error: error instanceof Error ? redact(error.message) : "Geocoding failed." },
      { status: 502 }
    );
  }
});
