import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/runtime-env", () => ({ databaseUrl: vi.fn(() => "postgres://test") }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({ pool: true }) }));
const runner = vi.hoisted(() => ({ runModelTick: vi.fn() }));
vi.mock("@/server/derived/model-runner", () => runner);
vi.mock("@/server/agent-activity", () => ({ noteAgentCall: () => {} }));

const env = await import("@/server/runtime-env");
const route = await import("./route");

const post = (body: unknown) =>
  route.POST(
    new Request("http://localhost/api/integrations/derived/model-tick", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body)
    }),
    undefined
  );

beforeEach(() => {
  runner.runModelTick.mockReset();
  vi.mocked(env.databaseUrl).mockReturnValue("postgres://test");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/integrations/derived/model-tick", () => {
  it("returns the status, the summary and each extractor's account for a scheduled tick", async () => {
    runner.runModelTick.mockResolvedValue({
      status: "ok",
      more: true,
      summary: "fact-llm v1 (active): ok.",
      extractors: [{ extractor: "fact-llm", status: "ok" }]
    });
    const response = await post({ trigger: "scheduled" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      trigger: "scheduled",
      more: true,
      summary: "fact-llm v1 (active): ok.",
      extractors: [{ extractor: "fact-llm", status: "ok" }]
    });
  });

  it("reports an empty registry as no_extractors, which the worker paces as idle", async () => {
    runner.runModelTick.mockResolvedValue({ status: "no_extractors", more: false, extractors: [], summary: "none" });
    expect(await (await post({ trigger: "scheduled" })).json()).toMatchObject({ status: "no_extractors", more: false });
  });

  it("answers busy for a manual tick, and for a body that names no trigger", async () => {
    runner.runModelTick.mockResolvedValue({ status: "busy" });
    expect(await (await post({ trigger: "manual" })).json()).toEqual({ status: "busy", trigger: "manual" });
    expect(await (await post("not json")).json()).toEqual({ status: "busy", trigger: "manual" });
  });

  it("skips, running nothing, without a database", async () => {
    vi.mocked(env.databaseUrl).mockReturnValue(undefined as never);
    expect(await (await post({ trigger: "scheduled" })).json()).toEqual({
      status: "skipped",
      reason: "no_database",
      trigger: "scheduled"
    });
    expect(runner.runModelTick).not.toHaveBeenCalled();
  });

  it("answers 502 when the run fails, so the worker tries again", async () => {
    runner.runModelTick.mockRejectedValue(new Error("connection reset"));
    const response = await post({ trigger: "scheduled" });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: "connection reset", trigger: "scheduled" });
  });
});
