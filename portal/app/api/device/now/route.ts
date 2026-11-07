import { withRoute } from "@/server/logging";
import { getStateStore } from "@/server/persistence/state-store";
import {
  buildDeviceSnapshot,
  deviceETag,
  deviceShownTarget,
  deviceETagMatches,
  readDeviceCheckIn
} from "@/server/device/device-now";
import { logDeviceShown } from "@/server/device/device-shown";
import { getCachedDeviceState, setCachedDeviceState } from "@/server/device/device-state-cache";
import type { PortalState } from "@/state/portal-state";

/**
 * The mini Now page an ESP32 handheld polls: one thing on the clock, whether it's late, whether
 * arrival is still unasserted, and what buttons do something — see `server/device/device-now.ts` for
 * how each field is derived, and the design notes for the wire contract the firmware
 * is written against. `ETag`/`If-None-Match` let a battery-powered device skip the body entirely on a
 * poll that changed nothing but the clock; `device-state-cache.ts` is what lets a poll skip the
 * ~25-query state hydration itself when a very recent one is still fresh enough to answer from — a
 * 304 alone didn't save that work, since the hydration ran before the ETag could even be compared.
 *
 * `no-store` is explicit rather than assumed: the response is a live reading of what is on the clock
 * right now, and the conditional request is the only caching this endpoint wants. Without it an
 * intermediary is entitled to apply its own heuristic freshness to a 200 and hand the device a
 * minutes-old snapshot it has no way to detect.
 */
const HEADERS = { "Cache-Control": "no-store" } as const;

export const GET = withRoute("/api/device/now", async (request) => {
  let state = getCachedDeviceState();
  if (!state) {
    state = (await getStateStore().get()) as PortalState | null;
    if (!state) return Response.json({ error: "State is unavailable." }, { status: 503, headers: HEADERS });
    setCachedDeviceState(state);
  }
  const checkIn = await readDeviceCheckIn();
  const snapshot = buildDeviceSnapshot(state, new Date(), checkIn);
  const etag = deviceETag(snapshot.stateVersion);
  if (deviceETagMatches(request.headers.get("if-none-match"), snapshot.stateVersion))
    return new Response(null, { status: 304, headers: { ...HEADERS, ETag: etag } });
  // A changed ETag is a new thing on the handheld's screen: record it, off the response path and never able to fail it.
  const resolvedState = state;
  void logDeviceShown(() => deviceShownTarget(resolvedState, new Date(snapshot.serverTime)));
  return Response.json(snapshot, { headers: { ...HEADERS, ETag: etag } });
});
