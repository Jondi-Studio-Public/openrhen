import { timingSafeEqual } from "node:crypto";
import { locationObservationSchema } from "@openrhen/contracts";
import { withLocationObservationStore } from "@/server/location/location-observation-store";
import { StaleLocationReadingError } from "@/server/location/observation-policy";
import { withRoute } from "@/server/logging";
import { locationPingToken } from "@/server/runtime-env";

/**
 * Where the phone says the device is.
 *
 * Other routes rely on owner sign-in (`OPENRHEN_OWNER_AUTH`, the design notes) or,
 * with it off, on the network. This one keeps its own token whatever that mode is: it is reachable on
 * the private network like the rest of the portal (behind an https reverse proxy), the phone carries no
 * owner credential, and its coordinates should not be forgeable by whatever else shares the network.
 * It is not the only route that can set the location: the device actions and `POST /api/commands/entity`
 * can too, to saved places only. The bearer token is the endpoint, not a hardening of it: with
 * `LOCATION_PING_TOKEN` unset the route refuses everything.
 *
 * Request body (JSON; never query parameters, which end up in proxy logs):
 *   { latitude, longitude, accuracyMeters, observedAt }
 *
 * Response:
 *   { decision: "asserted" | "refreshed" | "suggested", locationId, locationName, suggestion }
 * `asserted` means sustained presence moved the assertion, `refreshed` that the reading agreed with
 * it, `suggested` that a question was left for the interface to raise. See
 * `portal/server/location/observation-policy.ts` for the rules behind those three words.
 */
export const POST = withRoute("/api/location/ping", async (request, _context, log) => {
  if (!authorised(request.headers.get("authorization"), locationPingToken()))
    return Response.json({ error: "This endpoint requires a valid location token." }, { status: 401 });
  const parsed = locationObservationSchema.safeParse(await request.json().catch(() => null));
  // No issue list in the body: the shape it rejected is not something an
  // unauthenticated-by-shape caller needs described back to them.
  if (!parsed.success) return Response.json({ error: "The location reading failed validation." }, { status: 400 });
  log.setCommandType("location_ping");
  // Nothing about the coordinates reaches the log — not at info level, not at error level. The route
  // template, the decision word and the duration are the whole record of a ping.
  try {
    return Response.json(await withLocationObservationStore((store) => store.recordPhonePing(parsed.data)));
  } catch (error) {
    // A reading dated well outside receipt time is refused rather than clamped: stamping it "now"
    // would make an old place look fresh, and a future-dated one would pin the history.
    if (error instanceof StaleLocationReadingError)
      return Response.json({ error: "The reading's observedAt is too far from the server's clock." }, { status: 400 });
    throw error;
  }
});

function authorised(header: string | null, configuredToken: string | undefined) {
  if (!configuredToken || !header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(configuredToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
