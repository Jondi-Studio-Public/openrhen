import type { FlowEntry } from "../types.js";
import { flow } from "./define.js";

/** A registered activity source that nothing posts yet: accepted by the store, `noProducer` until a sender lands. */
const accepted = (id: string, name: string, activitySource: string, extra: Partial<FlowEntry>): FlowEntry =>
  flow({
    id,
    name,
    role: "source",
    category: "device",
    method: "push",
    trigger: { kind: "on-request", by: "device" },
    noProducer: true,
    activitySource,
    via: ["activity-ingest"],
    health: { kind: "activity", source: activitySource },
    ...extra
  });

/** Device feeds and their registered-but-silent siblings. */
export const DEVICE_ENTRIES: readonly FlowEntry[] = [
  accepted("iphone-shortcuts", "Phone shortcuts feed", "iphone-shortcuts", { device: "phone" }),
  accepted("iphone-health", "Health summary", "iphone-health", { device: "phone" }),
  // Provider-neutral: core ships no collector. The user's own collector maps wearable or health-app data onto the
  // physiology kinds and posts it to the ingest endpoint (docs/operations/posting-physiology-data.md).
  accepted("physiology", "Physiology (your own collector)", "physiology", { method: "push" }),
  accepted("rhen-watch", "PC activity agent", "rhen-watch", {
    device: "pc",
    category: "device",
    method: "device-agent"
  }),
  accepted("steam", "Game sessions", "steam", { category: "device", method: "api-pull" }),
  accepted("weather", "Weather observations", "weather", { category: "device", method: "api-pull" }),
  accepted("gmail", "Mail messages", "gmail", { category: "communications", method: "api-pull" }),
  flow({
    id: "phone-location",
    name: "Phone location",
    role: "source",
    category: "device",
    method: "device-agent",
    trigger: { kind: "on-request", by: "device" },
    device: "phone",
    code: {
      paths: ["portal/server/location/location-observation-store.ts"],
      routes: ["POST /api/location/ping", "POST /api/location/observe", "DELETE /api/location/suggestion"]
    },
    from: ["ext:device/phone"],
    to: ["pg:user_preferences"],
    incidentalWrites: [
      { table: "journey_samples", reason: "a location report can close a journey" },
      { table: "routine_steps", reason: "a place change can advance a routine step" },
      { table: "sessions", reason: "a place change can open or close a session" }
    ],
    health: {
      kind: "json-stamp",
      table: "user_preferences",
      column: "device_location_state",
      path: ["lastPhonePingAt"]
    }
  }),
  flow({
    id: "handheld-actions",
    name: "Handheld button taps",
    role: "source",
    category: "device",
    method: "device-agent",
    trigger: { kind: "on-request", by: "device" },
    code: { routes: ["POST /api/device/action"] },
    from: ["ext:handheld"],
    to: ["pg:actions", "pg:check_in", "pg:sessions"],
    health: { kind: "none", reason: "no per-device signal in core; an extension may add one" }
  }),
  flow({
    id: "photo-checkins",
    name: "Photo check-ins",
    role: "source",
    category: "device",
    method: "manual",
    trigger: { kind: "on-request", by: "owner" },
    code: {
      paths: ["portal/server/persistence/postgres/photo-checkin-store.ts", "portal/server/photos/photo-store.ts"],
      routes: [
        "POST /api/photo-checkins",
        "PATCH /api/photo-checkins/[id]",
        "PUT /api/photo-checkins/mode",
        "POST /api/place-photos"
      ]
    },
    from: ["blob:photo-upload"],
    to: ["pg:photo_checkin", "pg:photo_checkin_settings", "pg:place_reference_photo", "blob:photos"],
    health: { kind: "max", table: "photo_checkin", column: "created_at" }
  })
];
