import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The plan-map routes' own framing: body validation, the status each store refusal maps to, and that a
 * switch only changes on an explicit PUT. The store is replaced wholesale (it has an integration test).
 */
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => "postgres://test" }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
vi.mock("@/server/persistence/postgres/ensure-user", () => ({ ensureUser: async () => "user-1" }));

const store = vi.hoisted(() => ({
  listPlanMap: vi.fn(),
  createManualLink: vi.fn(),
  decideLink: vi.fn(),
  decideFinding: vi.fn(),
  reopenFinding: vi.fn(),
  bulkConfirm: vi.fn(),
  setSwitch: vi.fn(),
  sweepPlanMap: vi.fn()
}));
vi.mock("@/server/persistence/postgres/plan-map-store", () => store);
const health = vi.hoisted(() => ({ runPlanHealth: vi.fn() }));
vi.mock("@/server/persistence/postgres/plan-health-store", () => health);
const proposers = vi.hoisted(() => ({ runPlanMapProposers: vi.fn() }));
vi.mock("@/server/persistence/postgres/plan-map-proposers", () => proposers);
const reviewer = vi.hoisted(() => ({ runPlanReviewer: vi.fn() }));
vi.mock("@openrhen/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openrhen/database")>()),
  ...reviewer
}));

const runLog = vi.hoisted(() => ({ recordRun: vi.fn(async () => undefined) }));
vi.mock("@/server/persistence/postgres/run-log", () => runLog);

const catchUp = vi.hoisted(() => ({ queueCatchUpNudge: vi.fn() }));
vi.mock("@/server/persistence/postgres/catch-up", () => catchUp);

const links = await import("./links/route");
const linkById = await import("./links/[id]/route");
const bulk = await import("./links/bulk/route");
const findings = await import("./findings/[id]/route");
const switches = await import("./switches/route");
const sweep = await import("./sweep/route");
const propose = await import("./propose/route");
const map = await import("./route");

const post = (body: unknown, method = "POST") =>
  new Request("http://localhost/api/plan-map", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
const idContext = (id: string) => ({ params: Promise.resolve({ id }) });
const UUID = "11111111-1111-4111-8111-111111111111";
const input = { fromType: "project", fromId: "a", toType: "project", toId: "b", kind: "before" };

beforeEach(() => {
  for (const mock of [
    ...Object.values(store),
    ...Object.values(health),
    ...Object.values(proposers),
    ...Object.values(reviewer),
    ...Object.values(catchUp)
  ])
    mock.mockReset();
  runLog.recordRun.mockClear();
  health.runPlanHealth.mockResolvedValue({ mode: "off", found: 0, created: 0, cleared: 0 });
  catchUp.queueCatchUpNudge.mockResolvedValue({ due: false, queued: false });
});

describe("plan-map routes", () => {
  it("GET returns the map", async () => {
    store.listPlanMap.mockResolvedValue({ subjects: [], links: [], findings: [], switches: [] });
    const response = await map.GET(new Request("http://localhost/api/plan-map"), undefined);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ subjects: [], links: [], findings: [], switches: [] });
  });

  it("creates a link, and maps each refusal to its status", async () => {
    store.createManualLink.mockResolvedValueOnce({ ok: true, link: { id: UUID } });
    const created = await links.POST(post(input), undefined);
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({ link: { id: UUID } });
    for (const [code, status] of [
      ["invalid_ends", 400],
      ["missing_end", 404],
      ["rejected_pair", 409]
    ] as const) {
      store.createManualLink.mockResolvedValueOnce({ ok: false, code, reason: "no" });
      expect((await links.POST(post(input), undefined)).status).toBe(status);
    }
    expect((await links.POST(post({ ...input, kind: "friends" }), undefined)).status).toBe(400);
  });

  it("decides a link, with 404 for an unknown id and 409 for a kept rejection", async () => {
    store.decideLink.mockResolvedValueOnce({ ok: true, link: null });
    expect((await linkById.POST(post({ action: "remove" }), idContext(UUID))).status).toBe(200);
    expect(store.decideLink).toHaveBeenCalledWith({}, "user-1", UUID, "remove");
    store.decideLink.mockResolvedValueOnce({ ok: false, code: "not_found", reason: "No such link." });
    expect((await linkById.POST(post({ action: "confirm" }), idContext(UUID))).status).toBe(404);
    store.decideLink.mockResolvedValueOnce({ ok: false, code: "rejected_kept", reason: "kept" });
    expect((await linkById.POST(post({ action: "remove" }), idContext(UUID))).status).toBe(409);
    expect((await linkById.POST(post({ action: "confirm" }), idContext("not-a-uuid"))).status).toBe(404);
    expect((await linkById.POST(post({ action: "accept" }), idContext(UUID))).status).toBe(400);
  });

  it("reopens a decided link, and refuses one that was never decided", async () => {
    store.decideLink.mockResolvedValueOnce({ ok: true, link: { id: UUID, status: "suggested" } });
    const reopened = await linkById.POST(post({ action: "reopen" }), idContext(UUID));
    expect(reopened.status).toBe(200);
    expect(await reopened.json()).toEqual({ link: { id: UUID, status: "suggested" } });
    expect(store.decideLink).toHaveBeenCalledWith({}, "user-1", UUID, "reopen");
    store.decideLink.mockResolvedValueOnce({ ok: false, code: "not_decided", reason: "Not decided." });
    expect((await linkById.POST(post({ action: "reopen" }), idContext(UUID))).status).toBe(409);
    store.decideLink.mockResolvedValueOnce({ ok: false, code: "not_found", reason: "No such link." });
    expect((await linkById.POST(post({ action: "reopen" }), idContext(UUID))).status).toBe(404);
  });

  it("bulk-confirms by proposer and kind", async () => {
    store.bulkConfirm.mockResolvedValue(["l1", "l2", "l3"]);
    const response = await bulk.POST(post({ proposer: "rule:calendar", kind: "about" }), undefined);
    expect(await response.json()).toEqual({ confirmed: 3, ids: ["l1", "l2", "l3"] });
    expect((await bulk.POST(post({ proposer: "nobody", kind: "about" }), undefined)).status).toBe(400);
  });

  it("accepts or dismisses a finding", async () => {
    store.decideFinding.mockResolvedValueOnce({ id: UUID, status: "dismissed" });
    expect((await findings.POST(post({ action: "dismiss" }), idContext(UUID))).status).toBe(200);
    store.decideFinding.mockResolvedValueOnce(null);
    expect((await findings.POST(post({ action: "accept" }), idContext(UUID))).status).toBe(404);
    expect((await findings.POST(post({ action: "confirm" }), idContext(UUID))).status).toBe(400);
  });

  it("reopens a decided finding, and refuses one that is open or missing", async () => {
    store.reopenFinding.mockResolvedValueOnce({ ok: true, finding: { id: UUID, status: "open" } });
    const reopened = await findings.POST(post({ action: "reopen" }), idContext(UUID));
    expect(reopened.status).toBe(200);
    expect(await reopened.json()).toEqual({ finding: { id: UUID, status: "open" } });
    expect(store.reopenFinding).toHaveBeenCalledWith({}, "user-1", UUID);
    expect(store.decideFinding).not.toHaveBeenCalled();
    store.reopenFinding.mockResolvedValueOnce({ ok: false, code: "not_decided", reason: "Not decided." });
    expect((await findings.POST(post({ action: "reopen" }), idContext(UUID))).status).toBe(409);
    store.reopenFinding.mockResolvedValueOnce({ ok: false, code: "not_found", reason: "No such finding." });
    expect((await findings.POST(post({ action: "reopen" }), idContext(UUID))).status).toBe(404);
  });

  it("sets a switch only on a valid PUT", async () => {
    const response = await switches.PUT(post({ addon: "nudge", mode: "shadow" }, "PUT"), undefined);
    expect(response.status).toBe(200);
    expect(store.setSwitch).toHaveBeenCalledWith({}, "user-1", "nudge", "shadow");
    store.setSwitch.mockClear();
    expect((await switches.PUT(post({ addon: "nudge", mode: "maybe" }, "PUT"), undefined)).status).toBe(400);
    expect(store.setSwitch).not.toHaveBeenCalled();
    expect((await switches.PUT(post({ addon: "backfill", mode: "shadow" }, "PUT"), undefined)).status).toBe(400);
    expect((await switches.PUT(post({ addon: "navigator", mode: "on" }, "PUT"), undefined)).status).toBe(400);
    expect(store.setSwitch).not.toHaveBeenCalled();
  });

  it("refuses a switch change from any request that names an agent, and leaves the switch alone", async () => {
    const request = new Request("http://localhost/api/plan-map/switches", {
      method: "PUT",
      headers: { "content-type": "application/json", "x-openrhen-agent": "scribe" },
      body: JSON.stringify({ addon: "nudge", mode: "on" })
    });
    const response = await switches.PUT(request, undefined);
    expect(response.status).toBe(403);
    // The refusal says where the person does it.
    expect(((await response.json()) as { error: string }).error).toContain("in Settings > Add-ons and sign-in");
    expect(store.setSwitch).not.toHaveBeenCalled();
  });

  it("runs the sweep, then the proposers, and reports both", async () => {
    store.sweepPlanMap.mockResolvedValue({ orphanedLinksDeleted: 1, suggestionsExpired: 2, shadowRowsDeleted: 3 });
    health.runPlanHealth.mockResolvedValue({ mode: "shadow", found: 4, created: 2, cleared: 0 });
    proposers.runPlanMapProposers.mockResolvedValue({ mode: "shadow", suggested: 4, revived: 1, scores: [] });
    reviewer.runPlanReviewer.mockResolvedValue({ mode: "shadow", ran: true, queued: false, digest: null });
    const response = await sweep.POST(post({ trigger: "scheduled" }), undefined);
    expect(await response.json()).toEqual({
      status: "ok",
      trigger: "scheduled",
      orphanedLinksDeleted: 1,
      suggestionsExpired: 2,
      shadowRowsDeleted: 3,
      proposers: { mode: "shadow", suggested: 4, revived: 1 },
      reviewer: { mode: "shadow", ran: true, queued: false },
      catchUp: { due: false, queued: false },
      health: { mode: "shadow", found: 4, created: 2, cleared: 0 }
    });
    health.runPlanHealth.mockRejectedValue(new Error("health boom"));
    const isolated = await sweep.POST(post({ trigger: "scheduled" }), undefined);
    expect(isolated.status).toBe(200);
    expect(await isolated.json()).toMatchObject({ status: "ok", health: { mode: "error", error: "health boom" } });
    store.sweepPlanMap.mockRejectedValue(new Error("boom"));
    expect((await sweep.POST(post({ trigger: "scheduled" }), undefined)).status).toBe(502);
  });

  describe("the run row", () => {
    const quiet = { orphanedLinksDeleted: 0, suggestionsExpired: 0, shadowRowsDeleted: 0 };
    beforeEach(() => {
      proposers.runPlanMapProposers.mockResolvedValue({ mode: "off", suggested: 0, revived: 0, scores: [] });
      reviewer.runPlanReviewer.mockResolvedValue({ mode: "off", ran: false, queued: false, digest: null });
    });

    it("writes job:plan-map-sweep, synced, when the sweep changed something", async () => {
      store.sweepPlanMap.mockResolvedValue({ ...quiet, suggestionsExpired: 2 });
      await sweep.POST(post({ trigger: "scheduled" }), undefined);
      expect(runLog.recordRun).toHaveBeenCalledOnce();
      expect(runLog.recordRun).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "job:plan-map-sweep",
          trigger: "scheduled",
          status: "synced",
          summary: expect.objectContaining({ suggestionsExpired: 2 })
        })
      );
    });

    it("writes nothing for a quiet sweep", async () => {
      store.sweepPlanMap.mockResolvedValue(quiet);
      await sweep.POST(post({ trigger: "scheduled" }), undefined);
      expect(runLog.recordRun).not.toHaveBeenCalled();
    });

    it("writes a failed row, with the redacted error, when the sweep fails", async () => {
      store.sweepPlanMap.mockRejectedValue(new Error("boom"));
      expect((await sweep.POST(post({ trigger: "scheduled" }), undefined)).status).toBe(502);
      expect(runLog.recordRun).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "job:plan-map-sweep",
          trigger: "scheduled",
          status: "failed",
          summary: { error: "boom" }
        })
      );
    });

    it("records a manual sweep as manual", async () => {
      store.sweepPlanMap.mockResolvedValue({ ...quiet, shadowRowsDeleted: 1 });
      await sweep.POST(post({}), undefined);
      expect(runLog.recordRun).toHaveBeenCalledWith(expect.objectContaining({ trigger: "manual" }));
    });
  });

  it("does not fail the sweep when the proposers fail", async () => {
    store.sweepPlanMap.mockResolvedValue({ orphanedLinksDeleted: 0, suggestionsExpired: 0, shadowRowsDeleted: 0 });
    proposers.runPlanMapProposers.mockRejectedValue(new Error("boom"));
    reviewer.runPlanReviewer.mockResolvedValue({ mode: "off", ran: false, queued: false, digest: null });
    const response = await sweep.POST(post({ trigger: "scheduled" }), undefined);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { proposers: { error: string } }).proposers.error).toBeTruthy();
  });

  it("does not fail the sweep when the weekly reviewer fails", async () => {
    store.sweepPlanMap.mockResolvedValue({ orphanedLinksDeleted: 0, suggestionsExpired: 0, shadowRowsDeleted: 0 });
    proposers.runPlanMapProposers.mockResolvedValue({ mode: "off", suggested: 0, revived: 0, scores: [] });
    reviewer.runPlanReviewer.mockRejectedValue(new Error("boom"));
    const response = await sweep.POST(post({ trigger: "scheduled" }), undefined);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { reviewer: { error: string } }).reviewer.error).toBeTruthy();
  });

  it("runs the proposers on demand and maps a failure to 502", async () => {
    proposers.runPlanMapProposers.mockResolvedValue({ mode: "off", suggested: 0, revived: 0, scores: [] });
    const ok = await propose.POST(post({}), undefined);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: "ok", mode: "off" });
    proposers.runPlanMapProposers.mockRejectedValue(new Error("boom"));
    expect((await propose.POST(post({}), undefined)).status).toBe(502);
  });
});
