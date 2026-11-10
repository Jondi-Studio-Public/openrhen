import { timingSafeEqual } from "node:crypto";
import { OWNER_HEADER, phoneLocationPingSchema } from "@openrhen/contracts";
import { withLocationObservationStore } from "@/server/location/location-observation-store";
import { StaleLocationReadingError } from "@/server/location/observation-policy";
import { withRoute } from "@/server/logging";
import { verifyOwnerCredential } from "@/server/owner-auth";
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
 * A phone signed in by device sign-in may send its owner token in the `X-OpenRhen-Owner` header instead (a header
 * only: a cookie never moves the location, so a browser cannot). The route checks that token itself, because under
 * owner auth `off` and `shadow` no gate has. A revoked or unknown token gets the owner-auth error, not "requires a
 * valid location token". The token names the phone; sustained presence is then read per phone, so two phones cannot
 * break each other's run. `LOCATION_PING_TOKEN` keeps working for third-party collectors.
 *
 * Request body (JSON; never query parameters, which end up in proxy logs):
 *   { latitude, longitude, accuracyMeters, observedAt, device? }
 *
 * Response:
 *   { decision: "asserted" | "refreshed" | "suggested", locationId, locationName, suggestion }
 * `asserted` means sustained presence moved the assertion, `refreshed` that the reading agreed with
 * it, `suggested` that a question was left for the interface to raise. See
 * `portal/server/location/observation-policy.ts` for the rules behind those three words.
 */
export const POST = withRoute("/api/location/ping", async (request, _context, log) => {
  let tokenDevice: string | undefined;
  if (request.headers.get(OWNER_HEADER)?.trim()) {
    const check = await verifyOwnerCredential(request);
    if (check.kind !== "ok" || check.via !== "header" || check.credential !== "token")
      return Response.json(
        { error: check.kind === "invalid" ? check.error : "The owner credential is not recognised." },
        {
          status: check.kind === "invalid" ? check.status : 401,
          ...(check.kind === "invalid" && check.retryAfter
            ? { headers: { "retry-after": String(check.retryAfter) } }
            : {})
        }
      );
    tokenDevice = check.device?.installId;
  } else if (!authorised(request.headers.get("authorization"), locationPingToken()))
    return Response.json({ error: "This endpoint requires a valid location token." }, { status: 401 });
  const parsed = phoneLocationPingSchema.safeParse(await request.json().catch(() => null));
  // No issue list in the body: the shape it rejected is not something an
  // unauthenticated-by-shape caller needs described back to them.
  if (!parsed.success) return Response.json({ error: "The location reading failed validation." }, { status: 400 });
  const { device: declared, ...observation } = parsed.data;
  if (tokenDevice && declared && declared !== tokenDevice)
    return Response.json({ error: "The reading names a different device than the owner token." }, { status: 400 });
  const device = tokenDevice ?? declared;
  log.setCommandType("location_ping");
  // Nothing about the coordinates reaches the log — not at info level, not at error level. The route
  // template, the decision word and the duration are the whole record of a ping.
  try {
    return Response.json(
      await withLocationObservationStore((store) => store.recordPhonePing(observation, new Date(), device))
    );
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
