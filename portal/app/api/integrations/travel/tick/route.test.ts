import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/agent-activity", () => ({ noteAgentCall: () => {} }));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => "postgres://test" }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => async () => [] }));
vi.mock("@/server/persistence/postgres/ensure-user", () => ({ ensureUser: async () => "user-1" }));
const runLog = vi.hoisted(() => ({ recordRun: vi.fn(async () => true) }));
vi.mock("@/server/persistence/postgres/run-log", () => runLog);
const stateStore = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/server/persistence/state-store", () => ({ getStateStore: () => stateStore }));
const database = vi.hoisted(() => ({ readJourneySummary: vi.fn() }));
vi.mock("@openrhen/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openrhen/database")>()),
  ...database
}));
const plan = vi.hoisted(() => ({ buildTravelLookupPlan: vi.fn(), deriveTodayLegOrigins: vi.fn(() => []) }));
vi.mock("@/server/travel/lookup-plan", () => plan);
const spend = vi.hoisted(() => {
  class TravelBudgetRefusedError extends Error {
    constructor(
      message: string,
      readonly reason: string,
      readonly remaining: number
    ) {
      super(message);
    }
  }
  return { TravelBudgetRefusedError, spendTravelLookup: vi.fn(), readTravelLookupsRemaining: vi.fn() };
});
vi.mock("@/server/travel/travel-spend", () => spend);

const route = await import("./route");

const place = (id: string) => ({ id, kind: "location", latitude: 1, longitude: 2 });
const group = (step: string) => ({
  step,
  originLocationId: "a",
  destinationLocationIds: ["b"],
  mode: "car",
  departureAt: new Date("2026-11-09T01:00:00Z"),
  allowReserve: false
});
const tick = (body: unknown = { trigger: "scheduled" }) =>
  route.POST(
    new Request("http://localhost/api/integrations/travel/tick", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }),
    undefined
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  stateStore.get.mockResolvedValue({
    settings: { timezone: "UTC" },
    conditionDefinitions: [place("a"), place("b")]
  });
  database.readJourneySummary.mockResolvedValue({});
  spend.readTravelLookupsRemaining.mockResolvedValue({ remaining: 50 });
});

describe("POST /api/integrations/travel/tick run row", () => {
  it("writes job:travel-lookup, synced, with the count of lookups spent, when a tick did work", async () => {
    plan.buildTravelLookupPlan.mockReturnValue([group("now")]);
    spend.spendTravelLookup.mockResolvedValue({ remaining: 49 });
    expect((await tick()).status).toBe(200);
    expect(runLog.recordRun).toHaveBeenCalledOnce();
    expect(runLog.recordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "job:travel-lookup",
        trigger: "scheduled",
        status: "synced",
        summary: { groups: 1, spent: 1, remaining: 49 }
      })
    );
  });

  it("writes nothing for a quiet tick, one with no lookups to make or none that could be spent", async () => {
    plan.buildTravelLookupPlan.mockReturnValue([]);
    await tick();
    plan.buildTravelLookupPlan.mockReturnValue([group("later")]);
    spend.spendTravelLookup.mockRejectedValue(new spend.TravelBudgetRefusedError("exhausted", "exhausted", 0));
    await tick();
    expect(runLog.recordRun).not.toHaveBeenCalled();
  });

  it("writes a failed row when the tick fails", async () => {
    plan.buildTravelLookupPlan.mockReturnValue([group("now")]);
    spend.spendTravelLookup.mockRejectedValue(new Error("provider down"));
    expect((await tick()).status).toBe(502);
    expect(runLog.recordRun).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "job:travel-lookup",
        trigger: "scheduled",
        status: "failed",
        summary: { error: "provider down" }
      })
    );
  });

  it("records a manual tick as manual", async () => {
    plan.buildTravelLookupPlan.mockReturnValue([group("now")]);
    spend.spendTravelLookup.mockResolvedValue({ remaining: 49 });
    await tick({ trigger: "manual" });
    expect(runLog.recordRun).toHaveBeenCalledWith(expect.objectContaining({ trigger: "manual" }));
  });
});
