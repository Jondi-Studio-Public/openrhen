import { z } from "zod";
import {
  DEFAULT_LOCATION_STALE_AFTER_MINUTES,
  EMPTY_JOURNEY_INDEX,
  resolveMode,
  type TransportMode
} from "@openrhen/contracts";
import { redact, withRoute } from "@/server/logging";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { getStateStore } from "@/server/persistence/state-store";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";
import { TravelBudgetRefusedError, spendTravelLookup } from "@/server/travel/travel-spend";
import type { PortalState } from "@/state/portal-state";

/**
 * Manual Measure: measures one place from the
 * current confirmed location, through the one spender, and may spend the reserve. Replaces the old
 * bulk "refresh every located commitment" behaviour — the Situation panel's own bulk-refresh call is
 * removed alongside this (a later task updates that panel to call this route per place, and to read
 * `remaining` for "N of 100 lookups left today").
 */
const requestSchema = z.object({ toLocationId: z.string().min(1) });

const modeRowSchema = z.object({
  usual_transport_mode: z.enum(["car", "bike", "walk"]).nullable(),
  default_transport_mode: z.enum(["car", "bike", "walk"]).nullable()
});

export const POST = withRoute("/api/travel/refresh", async (request, _context, log) => {
  const body = await request.json().catch(() => null);
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Name the place to measure travel to." }, { status: 400 });

  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "Travel lookups require PostgreSQL." }, { status: 503 });
  const sql = sqlPool(connectionString);

  const state = (await getStateStore()
    .get()
    .catch(() => null)) as PortalState | null;
  if (!state) return Response.json({ error: "Portal state is unavailable." }, { status: 503 });

  const now = new Date();
  const timeZone = state.settings.timezone;

  // "The current confirmed place": the same staleness rule the projection and the matcher use
  // (`resolveSituation`'s `DEFAULT_LOCATION_STALE_AFTER_MINUTES`), applied directly here rather than
  // pulled in through the full `resolveSituation` (which needs the whole condition-definition graph
  // this route has no other use for).
  const originId = state.currentSituation.locationId;
  const setAt = state.currentSituation.locationSetAt ? new Date(state.currentSituation.locationSetAt) : undefined;
  const ageMinutes = setAt ? (now.getTime() - setAt.getTime()) / 60_000 : undefined;
  const stale = ageMinutes === undefined || ageMinutes > DEFAULT_LOCATION_STALE_AFTER_MINUTES;
  if (originId === null || stale)
    return Response.json({ error: "There is no current confirmed place to measure travel from." }, { status: 409 });

  const origin = state.conditionDefinitions.find((entry) => entry.id === originId);
  const destination = state.conditionDefinitions.find((entry) => entry.id === parsed.data.toLocationId);
  if (!destination) return Response.json({ error: "That place could not be found." }, { status: 404 });
  if (origin?.latitude === undefined || origin?.longitude === undefined)
    return Response.json({ error: "Your current place has no coordinates to measure from." }, { status: 409 });
  if (destination.latitude === undefined || destination.longitude === undefined)
    return Response.json({ error: "That place has no coordinates to measure to." }, { status: 409 });

  const userId = await ensureUser(sql);

  // The place's usual mode and the user's default mode are not yet on the portal-state wire — a
  // later task (`state-read.ts`) carries them there. Read directly so Manual Measure already
  // resolves a real mode rather than falling straight to "fastest by distance".
  const modeRows = await sql`
    SELECT
      (SELECT usual_transport_mode FROM condition_definitions WHERE user_id=${userId} AND id=${destination.id}) AS usual_transport_mode,
      (SELECT default_transport_mode FROM user_preferences WHERE user_id=${userId}) AS default_transport_mode
  `;
  const modeRow = modeRowSchema.safeParse(modeRows[0]);
  const placeUsualMode = (modeRow.success ? modeRow.data.usual_transport_mode : null) ?? undefined;
  const userDefaultMode = (modeRow.success ? modeRow.data.default_transport_mode : null) ?? undefined;

  // No commitment context for an ad hoc measurement, and no journey summary here (a single manual
  // lookup does not warrant the full request-build query) — `resolveMode` falls through to the
  // place's usual mode, the user's default, or the fastest mode by straight-line distance, exactly
  // as a browser caller with no journey index does today.
  const mode: TransportMode | undefined = resolveMode({
    ...(placeUsualMode !== undefined ? { placeUsualMode } : {}),
    ...(userDefaultMode !== undefined ? { userDefaultMode } : {}),
    transportModes: state.currentSituation.transportModes,
    journeys: EMPTY_JOURNEY_INDEX,
    from: {
      id: origin.id,
      latitude: origin.latitude,
      longitude: origin.longitude,
      ...(origin.travelMinutes !== undefined ? { storedMinutes: origin.travelMinutes } : {})
    },
    to: {
      id: destination.id,
      latitude: destination.latitude,
      longitude: destination.longitude,
      ...(destination.travelMinutes !== undefined ? { storedMinutes: destination.travelMinutes } : {})
    }
  });
  if (!mode) return Response.json({ error: "No travel mode is available to measure with." }, { status: 409 });

  try {
    const spend = await spendTravelLookup(
      sql,
      userId,
      timeZone,
      {
        originLocationId: origin.id,
        origin: { latitude: origin.latitude, longitude: origin.longitude },
        destinations: [
          { locationId: destination.id, latitude: destination.latitude, longitude: destination.longitude }
        ],
        mode,
        departureAt: now
      },
      // Manual Measure may spend the reserve.
      { allowReserve: true, now }
    );
    return Response.json({
      estimate: spend.estimates[0] ?? null,
      unroutable: spend.unroutable.includes(destination.id),
      remaining: spend.remaining
    });
  } catch (error) {
    if (error instanceof TravelBudgetRefusedError) {
      return Response.json({ error: error.message, remaining: error.remaining }, { status: 429 });
    }
    log.setError(error);
    return Response.json(
      { error: error instanceof Error ? redact(error.message) : "The travel lookup failed." },
      { status: 502 }
    );
  }
});
