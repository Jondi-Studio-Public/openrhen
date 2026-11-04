import { beforeEach, describe, expect, it, vi } from "vitest";

import { calendarProfile } from "@/server/persistence/postgres/imports/calendar-profiles/calendar";
import { registerDiffProfile } from "@/server/persistence/postgres/imports/calendar-diff-registry";

// A test-local profile with the traits the routes read (own sync body, last-good-run report), so the suite does not
// need a provider's profile registered.
registerDiffProfile("stub_own_sync", () => calendarProfile, { ownSync: true, reportsLastGoodRun: true });

const answers: unknown[][] = [];
vi.mock("@/server/persistence/postgres/sql-pool", () => ({
  sqlPool: () => async () => answers.shift() ?? []
}));
vi.mock("@/server/persistence/postgres/ensure-user", () => ({ ensureUser: async () => "user-1" }));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => "postgres://test", runtimeEnv: () => ({}) }));
vi.mock("@/server/events/state-events", () => ({ ensureCalendarPublishSubscribed: () => undefined }));
const runCalendarSync = vi.fn();
vi.mock("@/server/imports/calendar-sync", () => ({ runCalendarSync: (a: unknown) => runCalendarSync(a) }));
const proveCalendarSource = vi.fn(async (id: string) => ({ status: "ok", id }));
vi.mock("@/integrations/calendar-source-client", () => ({
  proveCalendarSource: (id: string) => proveCalendarSource(id)
}));
vi.mock("@/integrations/google-calendar/google-calendar-proxy-client", () => ({ fetchGoogleCalendars: vi.fn() }));
vi.mock("@/server/persistence/postgres/calendar-source-selections", () => ({
  listGoogleCalendarSelections: vi.fn(async () => []),
  saveGoogleCalendarSelections: vi.fn(async (_sql: unknown, calendars: unknown) => calendars)
}));

// Provider-free manifests: a roster-profile source and a calendar sink that declare their ops without a provider
// behind them, and a roster source a handler is registered for.
const stub = (id: string, capability: string, calendarSource?: object) => ({
  id,
  label: `Stub ${id}`,
  capabilities: [capability],
  secrets: { anyOf: [] },
  config: {},
  ...(calendarSource ? { calendarSource } : {})
});
const stubs: Record<string, unknown> = {
  stub_roster: stub("stub_roster", "calendar_source", { diffProfile: "stub_own_sync" }),
  stub_handled_roster: stub("stub_handled_roster", "calendar_source", { diffProfile: "stub_own_sync" }),
  stub_shared: stub("stub_shared", "calendar_source", { diffProfile: "shared_calendar" }),
  stub_sink: stub("stub_sink", "calendar_sink")
};
vi.mock("@openrhen/contracts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openrhen/contracts")>();
  return { ...actual, connectionManifest: (id: string) => stubs[id] ?? actual.connectionManifest(id) };
});

const { registerProviderConnectionHandlers } = await import("@/server/imports/provider-hooks");
const handlers = await import("./route-handlers");
const log = { setError: vi.fn() } as never;
const post = (body?: unknown) =>
  new Request("http://portal.test/x", {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
const get = () => new Request("http://portal.test/x");

const sync = vi.fn(async () => ({ status: "synced" }));
const proof = vi.fn(async () => ({ status: "failed" }));
registerProviderConnectionHandlers("stub_handled_roster", { sync, proof });

beforeEach(() => {
  answers.length = 0;
  vi.clearAllMocks();
});

async function expectUnsupported(response: Response) {
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ reason: "unsupported_operation" });
}

describe("connection route handlers", () => {
  it("answers 404 for an unknown id", async () => {
    const unknown = await handlers.syncPostHandler("nope", post(), {}, log);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ reason: "unknown_connection" });
  });

  it("runs the registered roster body for a roster profile, and the calendar sync for any other profile", async () => {
    expect(
      (await handlers.syncPostHandler("stub_handled_roster", post({ trigger: "scheduled" }), {}, log)).status
    ).toBe(200);
    expect(sync).toHaveBeenCalledWith({ trigger: "scheduled" });
    runCalendarSync.mockResolvedValue({ status: "failed" });
    expect((await handlers.syncPostHandler("stub_shared", post(), {}, log)).status).toBe(502);
    expect(runCalendarSync).toHaveBeenCalledWith({ provider: "stub_shared", trigger: "manual" });
  });

  it("answers 400 with the connection's own wording when a run throws", async () => {
    runCalendarSync.mockRejectedValue("boom");
    const response = await handlers.syncPostHandler("stub_shared", post(), {}, log);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "The Stub stub_shared sync failed." });
  });

  it("proves with the registered proof, else the generic calendar-source proof", async () => {
    expect((await handlers.proofGetHandler("stub_handled_roster", get(), {}, log)).status).toBe(502);
    expect(proof).toHaveBeenCalled();
    await handlers.proofGetHandler("stub_shared", get(), {}, log);
    expect(proveCalendarSource).toHaveBeenCalledWith("stub_shared");
  });

  it("never runs a roster body for a roster-profile connection with none registered", async () => {
    await expectUnsupported(await handlers.syncPostHandler("stub_roster", post({ trigger: "manual" }), {}, log));
    await expectUnsupported(await handlers.syncGetHandler("stub_roster", get(), {}, log));
    await expectUnsupported(await handlers.proofGetHandler("stub_roster", get(), {}, log));
    expect(answers).toEqual([]);
  });

  it("never serves Google's calendars to another connection", async () => {
    await expectUnsupported(await handlers.calendarsGetHandler("stub_shared", get(), {}, log));
    await expectUnsupported(await handlers.calendarsPutHandler("stub_shared", post({ calendars: [] }), {}, log));
  });

  it("never publishes, removes, write-proves or previews an import for a connection with no registered sink", async () => {
    const request = () => post({ confirm: true, mode: "new", timezone: "Australia/Sydney" });
    await expectUnsupported(await handlers.publishPostHandler("stub_sink", request(), {}, log));
    await expectUnsupported(await handlers.publishGetHandler("stub_sink", get(), {}, log));
    await expectUnsupported(await handlers.publishRemoveHandler("stub_sink", request(), {}, log));
    await expectUnsupported(await handlers.writeProofPostHandler("stub_sink", request(), {}, log));
    await expectUnsupported(await handlers.importPreviewHandler("stub_shared", request(), {}, log));
  });
});
