import { afterEach, describe, expect, it, vi } from "vitest";
import { scopesForRoute } from "../agent-routes.js";
import { BUILTIN_CONNECTIONS } from "./builtin-connections.js";
import { CALENDAR_FEED_ID, CALENDAR_FEED_URL_ENV } from "./calendar-feed-manifest.js";
import { connectionManifestSchema } from "./manifest.js";
import { connectionManifest, intervalCalendarSourceIds } from "./registry.js";

describe("the calendar feed manifest", () => {
  const manifest = connectionManifest(CALENDAR_FEED_ID)!;

  it("is valid and says what the design fixes", () => {
    expect(connectionManifestSchema.safeParse(manifest).success).toBe(true);
    expect(manifest).toMatchObject({
      id: "calendar_feed",
      capabilities: ["calendar_source"],
      ops: { calendar_source: ["proof", "read_events"] },
      secrets: { anyOf: [["CALENDAR_FEED_URL"]] },
      calendarSource: {
        role: "secondary",
        sourceType: "calendar_feed_event",
        diffProfile: "fixed_blocks",
        authFailure: { anyFailure: false, reasons: [] }
      }
    });
    expect(CALENDAR_FEED_URL_ENV).toBe("CALENDAR_FEED_URL");
  });

  it("has no telemetry name, so the status route can never probe (download) the feed", () => {
    expect(manifest.telemetryName).toBeUndefined();
  });

  it("lists no secret but the URL and needs no other env to be ready", () => {
    expect(manifest.secrets.anyOf.flat()).toEqual(["CALENDAR_FEED_URL"]);
    expect(Object.values(manifest.config).every((field) => !field.required)).toBe(true);
  });

  it("joins the interval sources after Google, never ahead of it, and is not a core built-in", () => {
    expect(intervalCalendarSourceIds()[0]).toBe("google_calendar");
    expect(intervalCalendarSourceIds()).toContain("calendar_feed");
    expect(BUILTIN_CONNECTIONS.map((c) => c.id)).not.toContain("calendar_feed");
  });
});

describe("owner-only: no new route, and the generic connection routes refuse an agent", () => {
  it("classifies sync (read and write) and proof as owner-only", () => {
    expect(scopesForRoute("POST", "/api/connections/[connectionId]/sync")).toMatchObject({ reason: "owner-only" });
    expect(scopesForRoute("GET", "/api/connections/[connectionId]/sync")).toMatchObject({ reason: "owner-only" });
    expect(scopesForRoute("GET", "/api/connections/[connectionId]/proof")).toMatchObject({ reason: "owner-only" });
  });
});

describe("with the private seam emptied, as in the OpenRhen export", () => {
  afterEach(() => {
    vi.doUnmock("../private/index.js");
    vi.resetModules();
  });

  it("still registers the feed, once, and nothing the seam would have added (the core list plus the feed is the whole registry)", async () => {
    vi.resetModules();
    vi.doMock("../private/index.js", () => ({}));
    const registry = await import("./registry.js");
    await import("./connection-id.js");
    const ids = registry.connectionRegistry().map((c) => c.id);
    expect(ids).toEqual([...BUILTIN_CONNECTIONS.map((c) => c.id), "calendar_feed"]);
    expect(registry.calendarSourceIds()).toEqual(["google_calendar", "calendar_feed"]);
    expect(registry.intervalCalendarSourceIds()).toEqual(["google_calendar", "calendar_feed"]);
    expect(registry.connectionManifest("calendar_feed")?.calendarSource?.diffProfile).toBe("fixed_blocks");
    // Importing the module again changes nothing: registering an id twice is a no-op.
    await import("./calendar-feed-manifest.js");
    expect(registry.connectionRegistry().filter((c) => c.id === "calendar_feed")).toHaveLength(1);
  });
});
