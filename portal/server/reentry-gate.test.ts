import { beforeEach, describe, expect, it, vi } from "vitest";
import { REENTRY_REQUIRED_INSTRUCTION, type PulseReentryView } from "@openrhen/contracts";

/**
 * The agent gate: while the pulse is `off/lapsed`, every agent call but
 * re-entry is refused with `reentryRequired`, and the handler never runs, so no data and no directive leaves.
 */
const identity = vi.hoisted(() => ({ current: undefined as undefined | { actor: string; principal: unknown } }));
vi.mock("@/server/agent-tokens", () => ({
  identifyRequest: async () => identity.current ?? { actor: undefined }
}));
vi.mock("@/server/agent-enforcement", () => ({ enforceAgentRequest: async () => null }));
const view = vi.hoisted(() => ({ current: null as null | { view: PulseReentryView; lapsed: boolean }, throws: false }));
vi.mock("@/server/persistence/postgres/reenter", () => ({
  readPulseReentryView: async () => {
    if (view.throws) throw new Error("database is down");
    return view.current;
  },
  readReentryChoices: async () => ({
    places: [{ id: "place-home", name: "Home" }],
    contexts: [
      { id: "desktop", name: "Desktop", kind: "device" },
      { id: "online", name: "Online", kind: "capability" }
    ]
  })
}));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => "postgres://test" }));

const { withRoute } = await import("./logging");

const LAPSED: PulseReentryView = {
  state: "off",
  reason: "lapsed",
  since: "2026-10-28T01:00:00.000Z",
  lastConfirmedAt: "2026-10-27T01:00:00.000Z",
  silenceUntil: null,
  reentry: { due: true, tier: "today", gapMinutes: 1440, missing: ["location", "energy", "contexts", "review 3 items"] }
};

const secret = { directive: "Do the secret thing", plan: ["private data"] };
const handler = vi.fn(async () => Response.json(secret));
const call = (method: string, route: string) =>
  withRoute(route, handler)(
    new Request(`http://portal.test${route}`, { method, body: method === "GET" ? null : "{}" }),
    undefined
  );

const AS_AGENT = { actor: "companion", principal: { name: "companion", source: "env", directWrites: {} } };

beforeEach(() => {
  handler.mockClear();
  identity.current = AS_AGENT;
  view.current = { view: LAPSED, lapsed: true };
  view.throws = false;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

/** One route per class of tool call an agent makes. */
const TOOL_CLASSES: [string, string, string][] = [
  ["a plan read (status, list, show, state)", "GET", "/api/state"],
  ["a ledger read (catch-up)", "GET", "/api/catch-up"],
  ["a data read (doctor)", "GET", "/api/doctor"],
  ["an attention read (the feed and its counts)", "GET", "/api/attention"],
  ["a file read", "GET", "/api/photo-checkins"],
  ["a plan write (save)", "POST", "/api/commands/entity"],
  ["a check-in answer", "POST", "/api/commands/check-in"],
  ["a session write", "POST", "/api/commands/session"],
  ["a disruption (an activity write)", "POST", "/api/commands/activity"],
  ["a catch-up settle", "POST", "/api/commands/catch-up-settle"],
  ["an arrival or situation write", "POST", "/api/commands/entity"],
  ["an undo", "POST", "/api/commands/revert"],
  ["a recalculate", "POST", "/api/commands/recalculate"],
  ["a pulse disruption", "POST", "/api/commands/pulse-disruption"]
];

describe("the agent gate while the pulse is lapsed", () => {
  it.each(TOOL_CLASSES)("refuses %s with reentryRequired and runs nothing", async (_name, method, route) => {
    const response = await call(method, route);
    expect(response.status).toBe(428);
    const body = await response.json();
    expect(body).toEqual({
      code: "reentryRequired",
      error: REENTRY_REQUIRED_INSTRUCTION,
      pulse: LAPSED,
      missing: LAPSED.reentry.missing,
      choices: {
        places: [{ id: "place-home", name: "Home" }],
        contexts: [
          { id: "desktop", name: "Desktop" },
          { id: "online", name: "Online" }
        ],
        energies: ["high", "medium", "low", "recovery"]
      },
      example: expect.stringContaining(
        "rhen_reenter location=place-home energy=<high|medium|low|recovery> contexts=desktop,online basis=stated"
      )
    });
    expect(handler).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it.each([
    ["re-entry itself", "POST", "/api/commands/reenter"],
    ["the same read under the re-entry scope", "GET", "/api/commands/reenter"],
    ["the read that says what re-entry needs", "GET", "/api/pulse/reentry"],
    ["the CLI's version check", "GET", "/api/cli/version"],
    ["agent time ingest", "POST", "/api/agent-sessions"]
  ])("lets %s through", async (_name, method, route) => {
    expect((await call(method, route)).status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("holds a header-only agent as well as a token's", async () => {
    identity.current = { actor: "scribe", principal: { name: "scribe", source: "header", directWrites: {} } };
    expect((await call("GET", "/api/state")).status).toBe(428);
  });

  it("does not hold the owner's own session or an anonymous caller", async () => {
    identity.current = undefined;
    expect((await call("GET", "/api/state")).status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("lets every call through when the pulse is on, unknown, or never recorded", async () => {
    for (const current of [
      {
        view: {
          ...LAPSED,
          state: "on" as const,
          reason: "confirmed",
          reentry: { ...LAPSED.reentry, due: false, missing: [] }
        },
        lapsed: false
      },
      {
        view: {
          ...LAPSED,
          state: "unknown" as const,
          reason: null,
          reentry: { ...LAPSED.reentry, due: false, missing: [] }
        },
        lapsed: false
      },
      null
    ]) {
      view.current = current;
      expect((await call("GET", "/api/state")).status).toBe(200);
    }
  });

  it("fails open when the pulse cannot be read: it guards freshness, not access", async () => {
    view.throws = true;
    expect((await call("GET", "/api/state")).status).toBe(200);
  });
});
