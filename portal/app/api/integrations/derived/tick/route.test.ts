import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/runtime-env", () => ({ databaseUrl: vi.fn(() => "postgres://test") }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({ pool: true }) }));
const runner = vi.hoisted(() => ({ runDerivedTick: vi.fn() }));
vi.mock("@/server/derived/derived-runner", () => runner);
vi.mock("@/server/agent-activity", () => ({ noteAgentCall: () => {} }));

const env = await import("@/server/runtime-env");
const route = await import("./route");

const post = (body: unknown) =>
  route.POST(
    new Request("http://localhost/api/integrations/derived/tick", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body)
    }),
    undefined
  );

beforeEach(() => {
  runner.runDerivedTick.mockReset();
  vi.mocked(env.databaseUrl).mockReturnValue("postgres://test");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/integrations/derived/tick", () => {
  it("runs the extractors and returns the counts, for a scheduled tick", async () => {
    runner.runDerivedTick.mockResolvedValue({
      status: "ok",
      more: true,
      extractors: [{ extractor: "msg-class-t0", written: 3 }]
    });
    const response = await post({ trigger: "scheduled" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      trigger: "scheduled",
      more: true,
      extractors: [{ extractor: "msg-class-t0", written: 3 }]
    });
    expect(runner.runDerivedTick).toHaveBeenCalledTimes(1);
  });

  it("treats a manual tick, and a body that names no trigger, the same way: both run, both can be busy", async () => {
    runner.runDerivedTick.mockResolvedValue({ status: "busy" });
    expect(await (await post({ trigger: "manual" })).json()).toEqual({ status: "busy", trigger: "manual" });
    expect(await (await post("not json")).json()).toEqual({ status: "busy", trigger: "manual" });
    expect(await (await post({ trigger: "weekly" })).json()).toEqual({ status: "busy", trigger: "manual" });
    expect(runner.runDerivedTick).toHaveBeenCalledTimes(3);
  });

  it("skips, running nothing, without a database", async () => {
    vi.mocked(env.databaseUrl).mockReturnValue(undefined as never);
    const response = await post({ trigger: "scheduled" });
    expect(await response.json()).toEqual({ status: "skipped", reason: "no_database", trigger: "scheduled" });
    expect(runner.runDerivedTick).not.toHaveBeenCalled();
  });

  it("answers 502 when the run fails, so the worker tries again", async () => {
    runner.runDerivedTick.mockRejectedValue(new Error("connection reset"));
    const response = await post({ trigger: "scheduled" });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: "connection reset", trigger: "scheduled" });
  });
});
