import { describe, expect, it } from "vitest";
import { BUILTIN_CONNECTIONS } from "./builtin-connections.js";
import { CAPABILITY_OPS, type CapabilityId } from "./capabilities.js";
import { connectionIdSchema } from "./connection-id.js";
import { connectionManifestSchema } from "./manifest.js";
import {
  calendarSourceConnections,
  connectionManifest,
  connectionRegistry,
  isRegisteredConnection,
  resolveConnection,
  sourceLabel,
  sourceRoleOf
} from "./registry.js";

describe("built-in connections", () => {
  it("are in order, parse, are unique and none is reserved", () => {
    expect(BUILTIN_CONNECTIONS.map((c) => c.id)).toEqual([
      "google_calendar",
      "google",
      "openai",
      "deepinfra",
      "ollama",
      "pulse",
      "youtube_data"
    ]);
    for (const manifest of BUILTIN_CONNECTIONS) {
      expect(connectionManifestSchema.safeParse(manifest).success).toBe(true);
      expect(connectionIdSchema.safeParse(manifest.id).success).toBe(true);
    }
    expect(new Set(BUILTIN_CONNECTIONS.map((c) => c.id)).size).toBe(BUILTIN_CONNECTIONS.length);
  });

  it("use today's env names", () => {
    const env = BUILTIN_CONNECTIONS.flatMap((c) => [...c.secrets.anyOf.flat(), ...Object.keys(c.config)]);
    expect([...new Set(env)].sort()).toEqual(
      [
        "CALENDAR_SYNC_INTERVAL_MINUTES",
        "CALENDAR_SYNC_MAX_DELETES",
        "CALENDAR_SYNC_PROVIDERS",
        "CALENDAR_SYNC_WINDOW_DAYS",
        "DEEPINFRA_API_KEY",
        "DEEPINFRA_EMBEDDING_MODEL",
        "GOOGLE_CALENDAR_CLIENT_ID",
        "GOOGLE_CALENDAR_CLIENT_SECRET",
        "GOOGLE_CALENDAR_REFRESH_TOKEN",
        "GOOGLE_MAPS_API_KEY",
        "OPENAI_API_KEY",
        "PULSE_PUBLISH_SECRET",
        "PULSE_PUBLISH_URL"
      ].sort()
    );
  });

  it("gives a telemetry name only to google_calendar, google and openai", () => {
    expect(BUILTIN_CONNECTIONS.filter((c) => c.telemetryName).map((c) => c.id)).toEqual([
      "google_calendar",
      "google",
      "openai"
    ]);
  });

  it("lists the core calendar source first", () => {
    const first = calendarSourceConnections()[0];
    expect([first?.id, first?.calendarSource?.diffProfile, first?.calendarSource?.role]).toEqual([
      "google_calendar",
      "calendar",
      "secondary"
    ]);
  });
});

describe("registry", () => {
  it("answers roles, labels and membership", () => {
    expect(connectionRegistry().slice(0, BUILTIN_CONNECTIONS.length)).toEqual(BUILTIN_CONNECTIONS);
    expect(sourceRoleOf("google_calendar")).toBe("secondary");
    expect(sourceRoleOf("nope")).toBe("secondary");
    expect(["google_calendar"].map(sourceLabel)).toEqual(["Google Calendar"]);
    expect(sourceLabel("constructor")).toBe("Constructor");
    expect(["email", "apple_calendar", "some_new_thing"].map(sourceLabel)).toEqual([
      "Email",
      "Apple Calendar",
      "Some New Thing"
    ]);
    expect(isRegisteredConnection("pulse")).toBe(true);
    expect(isRegisteredConnection("email")).toBe(false);
  });

  it("has exactly one declarer for the single-provider ops", () => {
    const single: [CapabilityId, readonly string[]][] = [
      ["travel_time", CAPABILITY_OPS.travel_time],
      ["geocoding", CAPABILITY_OPS.geocoding],
      ["status_publish", CAPABILITY_OPS.status_publish],
      // `complete` has two providers by design (DeepInfra and Ollama); callers name the connection.
      ["model_provider", CAPABILITY_OPS.model_provider.filter((op) => op !== "complete")]
    ];
    for (const [capability, ops] of single) {
      for (const op of ops) {
        const declarers = BUILTIN_CONNECTIONS.filter((c) => {
          if (!c.capabilities.includes(capability)) return false;
          return (c.ops?.[capability] ?? CAPABILITY_OPS[capability]).some((o) => o === op);
        });
        expect(declarers, `${capability}.${op}`).toHaveLength(1);
      }
    }
  });

  it("has the two complete providers, each named by the caller", () => {
    const declarers = BUILTIN_CONNECTIONS.filter((c) => c.ops?.model_provider?.some((op) => op === "complete"));
    expect(declarers.map((c) => c.id)).toEqual(["deepinfra", "ollama"]);
    expect(connectionManifest("ollama")?.credentialSource).toBe("request");
  });

  it("resolves a connection by capability and op, and throws when none declares it", () => {
    expect(resolveConnection("model_provider", "embed").id).toBe("deepinfra");
    expect(resolveConnection("model_provider", "stream").id).toBe("openai");
    expect(resolveConnection("geocoding", "geocode").id).toBe("google");
    expect(resolveConnection("calendar_source", "list_calendars").id).toBe("google_calendar");
    expect(connectionManifest("google_calendar")?.ops?.calendar_source).toContain("list_calendars");
    expect(() => resolveConnection("calendar_sink", "nope")).toThrow();
  });
});
