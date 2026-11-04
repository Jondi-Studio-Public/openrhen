import { describe, expect, it, vi } from "vitest";
import {
  CONNECTION_IDS,
  connectionsAnswer,
  deriveConnectionSummaries,
  type ConnectionSummary
} from "./connection-summaries";
import type { ConnectionInputs, ProviderStatusView } from "./use-connection-data";

// The core connections only: the seam is stubbed empty, as it is in the OpenRhen export (an extension's connections
// are pinned by its own tests).
vi.mock("@/state/private/index", () => ({}));

const now = new Date("2026-11-03T22:00:00.000Z"); // 9:00 am on the 4th in the seed zone
const timezone = "Australia/Sydney";

const provider = (
  name: ProviderStatusView["provider"],
  overrides: Partial<ProviderStatusView> = {}
): ProviderStatusView => ({
  provider: name,
  reachable: true,
  source: "probe",
  checkedAt: "2026-11-03T21:30:00.000Z",
  detail: null,
  rateLimited: false,
  avgFirstByteMs: null,
  firstByteSampleCount: 0,
  avgTotalMs: null,
  totalSampleCount: 0,
  lastCallAt: null,
  lastCallOk: null,
  lastCallOperation: null,
  callCountsByOperation: [],
  inputTokens24h: null,
  outputTokens24h: null,
  ...overrides
});

function inputs(overrides: Partial<ConnectionInputs> = {}): ConnectionInputs {
  return {
    ready: true,
    timezone,
    planning: { status: "current", lastSuccessfulAt: "2026-11-03T21:33:00.000Z" },
    probe: { state: "reachable", latencyMs: 3, status: "ok", contractVersion: "1", engineVersion: "1" },
    providers: { openai: provider("openai"), google: provider("google") },
    googleProof: { status: "connected", checkedAt: now.toISOString(), calendarCount: 2 },
    googleSync: {
      state: "loaded",
      run: {
        startedAt: "2026-11-03T21:30:00.000Z",
        finishedAt: "2026-11-03T21:30:04.000Z",
        trigger: "scheduled",
        status: "synced",
        summary: null
      }
    },
    extensions: {},
    ...overrides
  };
}

const byId = (summaries: ConnectionSummary[], id: string) => summaries.find((s) => s.id === id)!;

describe("deriveConnectionSummaries", () => {
  it("returns the core connections in a fixed order with plain titles", () => {
    const summaries = deriveConnectionSummaries(inputs(), now);
    expect(summaries.map((s) => s.id)).toEqual([...CONNECTION_IDS]);
    expect(summaries.map((s) => s.title)).toEqual(["Planner", "Google Calendar", "OpenAI", "Google Maps"]);
  });

  it("reads everything as on when every read came back healthy", () => {
    const summaries = deriveConnectionSummaries(inputs(), now);
    expect(summaries.every((s) => s.state === "on")).toBe(true);
    expect(byId(summaries, "planner").meta).toBe("Recalculated 8:33 am");
    expect(byId(summaries, "google-calendar").meta).toBe("Synced 8:30 am");
    expect(byId(summaries, "openai").meta).toBe("Checked 8:30 am");
  });

  it("shows a date instead of a time for something that happened on another day", () => {
    const summaries = deriveConnectionSummaries(
      inputs({ planning: { status: "current", lastSuccessfulAt: "2026-11-01T01:00:00.000Z" } }),
      now
    );
    expect(byId(summaries, "planner").meta).toBe("Recalculated 1 Nov");
  });

  it("checks while the first answers are still on their way", () => {
    const summaries = deriveConnectionSummaries(
      inputs({
        ready: false,
        googleProof: { status: "loading" },
        providers: {}
      }),
      now
    );
    expect(summaries.every((s) => s.state === "checking")).toBe(true);
  });

  it("marks a missing server setting as setup, never naming the setting", () => {
    const summaries = deriveConnectionSummaries(
      inputs({
        probe: { state: "unreachable", configured: false, detail: "PLAN_FORECAST_SERVICE_URL is not set" },
        googleProof: { status: "not_configured", missing: ["GOOGLE_CALENDAR_REFRESH_TOKEN"] },
        providers: {
          openai: provider("openai", { source: "not_configured", reachable: null }),
          google: provider("google", { source: "not_configured", reachable: null })
        }
      }),
      now
    );
    expect(byId(summaries, "planner")).toMatchObject({ state: "setup", meta: "Needs a setting on the server" });
    expect(byId(summaries, "planner").optional).toBeUndefined();
    // Everything but the Planner is optional: nothing configured is not a problem, so it reads neutrally.
    for (const id of ["google-calendar", "openai", "google-maps"]) {
      expect(byId(summaries, id)).toMatchObject({ state: "setup", optional: true, meta: "Not connected (optional)" });
    }
  });

  it("does not mark an optional connection that is configured and failing", () => {
    const summaries = deriveConnectionSummaries(
      inputs({ providers: { openai: provider("openai", { reachable: false }), google: provider("google") } }),
      now
    );
    expect(byId(summaries, "openai").optional).toBeUndefined();
    expect(byId(summaries, "openai").state).toBe("off");
  });

  it("marks failures as off with the reason in words", () => {
    const summaries = deriveConnectionSummaries(
      inputs({
        probe: { state: "unreachable", configured: true, detail: "down" },
        providers: { openai: provider("openai", { reachable: false }), google: provider("google") },
        googleSync: {
          state: "loaded",
          run: { startedAt: now.toISOString(), finishedAt: null, trigger: "manual", status: "failed", summary: null }
        }
      }),
      now
    );
    expect(summaries.filter((s) => s.state === "off").map((s) => s.id)).toEqual([
      "planner",
      "google-calendar",
      "openai"
    ]);
    expect(byId(summaries, "planner").meta).toBe("Not answering");
  });

  it("reads a stale or failed plan as off and a pending one as still on", () => {
    expect(byId(deriveConnectionSummaries(inputs({ planning: { status: "stale" } }), now), "planner")).toMatchObject({
      state: "off",
      meta: "Recalculation is overdue"
    });
    expect(byId(deriveConnectionSummaries(inputs({ planning: { status: "failed" } }), now), "planner").state).toBe(
      "off"
    );
    expect(byId(deriveConnectionSummaries(inputs({ planning: { status: "pending" } }), now), "planner")).toMatchObject({
      state: "on",
      meta: "Recalculating"
    });
  });

  it("asks for Google Calendar sync to be switched on at the server when it is off", () => {
    const summaries = deriveConnectionSummaries(inputs({ googleSync: { state: "off" } }), now);
    expect(byId(summaries, "google-calendar").state).toBe("setup");
  });

  it("treats a Google Maps check with nothing to refresh as on", () => {
    const summaries = deriveConnectionSummaries(
      inputs({
        providers: { openai: provider("openai"), google: provider("google", { source: "skipped", reachable: null }) }
      }),
      now
    );
    expect(byId(summaries, "google-maps")).toMatchObject({ state: "on", meta: "Nothing to refresh lately" });
  });
});

describe("connectionsAnswer", () => {
  const make = (states: Record<string, ConnectionSummary["state"]>): ConnectionSummary[] =>
    Object.entries(states).map(([title, state]) => ({ id: title.toLowerCase(), title, state, meta: "" }));

  it("says everything is connected when every row is on", () => {
    expect(connectionsAnswer(make({ Planner: "on", Roster: "on" }))).toBe("Everything is connected.");
  });

  it("names the one connection that needs a setting", () => {
    expect(connectionsAnswer(make({ Planner: "on", Roster: "setup" }))).toBe(
      "Everything is connected except Roster, which needs a setting on the server."
    );
  });

  it("names the one connection that is not working", () => {
    expect(connectionsAnswer(make({ Planner: "off", Roster: "on" }))).toBe(
      "Everything is connected except Planner, which is not working."
    );
  });

  it("counts and lists several that need attention", () => {
    expect(connectionsAnswer(make({ Planner: "on", Roster: "setup", OpenAI: "off", Maps: "setup" }))).toBe(
      "3 of 4 connections need attention: Roster, OpenAI and Maps."
    );
  });

  describe("with optional connections", () => {
    const row = (title: string, state: ConnectionSummary["state"], optional = false): ConnectionSummary => ({
      id: title.toLowerCase(),
      title,
      state,
      meta: "",
      ...(optional ? { optional: true } : {})
    });

    it("is not worried when only optional connections are unconfigured", () => {
      expect(
        connectionsAnswer([row("Planner", "on"), row("OpenAI", "setup", true), row("Roster", "setup", true)])
      ).toBe("Nothing is connected yet; all of these are optional.");
      expect(connectionsAnswer([row("Planner", "unknown"), row("Roster", "setup", true)])).toBe(
        "Nothing is connected yet; all of these are optional."
      );
    });

    it("keeps a Planner that is not set up as a problem", () => {
      expect(connectionsAnswer([row("Planner", "setup"), row("OpenAI", "setup", true)])).toBe(
        "Planner needs a setting on the server."
      );
    });

    it("leaves optional rows out of the problem list and count", () => {
      expect(connectionsAnswer([row("Planner", "on"), row("OpenAI", "off"), row("Roster", "setup", true)])).toBe(
        "OpenAI is not working."
      );
    });

    it("does not claim everything when some optional ones are not connected", () => {
      expect(connectionsAnswer([row("Planner", "on"), row("OpenAI", "on"), row("Roster", "setup", true)])).toBe(
        "Everything you have connected is working."
      );
    });
  });

  it("says it is checking until the first answers are in, and still reports a known problem", () => {
    expect(connectionsAnswer(make({ Planner: "checking", Roster: "on" }))).toBe("Checking your connections.");
    expect(connectionsAnswer(make({ Planner: "checking", Roster: "setup" }))).toBe(
      "Everything is connected except Roster, which needs a setting on the server."
    );
    expect(connectionsAnswer([])).toBe("Checking your connections.");
  });
});
