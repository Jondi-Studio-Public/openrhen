import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/runtime-env", () => ({ databaseUrl: vi.fn(() => "postgres://test") }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({ pool: true }) }));
const runner = vi.hoisted(() => ({ runWorkLabelTick: vi.fn() }));
vi.mock("@/server/drift/work-label-runner", () => runner);
vi.mock("@/server/agent-activity", () => ({ noteAgentCall: () => {} }));

const env = await import("@/server/runtime-env");
const route = await import("./route");

const post = (body: unknown) =>
  route.POST(
    new Request("http://localhost/api/integrations/work-label/tick", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body)
    }),
    undefined
  );

beforeEach(() => {
  runner.runWorkLabelTick.mockReset();
  vi.mocked(env.databaseUrl).mockReturnValue("postgres://test");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/integrations/work-label/tick", () => {
  it("returns the run's answer with the trigger", async () => {
    runner.runWorkLabelTick.mockResolvedValue({
      status: "ok",
      more: true,
      areaId: "a1",
      label: "work",
      summary: "Labelled one area (work)."
    });
    const response = await post({ trigger: "scheduled" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      more: true,
      areaId: "a1",
      label: "work",
      summary: "Labelled one area (work).",
      trigger: "scheduled"
    });
  });

  it("treats a body with no trigger, or one that is not JSON, as manual", async () => {
    runner.runWorkLabelTick.mockResolvedValue({ status: "idle", more: false, summary: "none" });
    expect(await (await post("not json")).json()).toMatchObject({ status: "idle", trigger: "manual" });
    expect(await (await post({ trigger: "other" })).json()).toMatchObject({ trigger: "manual" });
  });

  it("skips, running nothing, without a database", async () => {
    vi.mocked(env.databaseUrl).mockReturnValue(undefined as never);
    expect(await (await post({ trigger: "scheduled" })).json()).toEqual({
      status: "skipped",
      reason: "no_database",
      trigger: "scheduled"
    });
    expect(runner.runWorkLabelTick).not.toHaveBeenCalled();
  });

  it("answers 502 with a fixed sentence, never the error's own text, so the worker tries again", async () => {
    runner.runWorkLabelTick.mockRejectedValue(new Error("failed near the area called Synthetic Study"));
    const response = await post({ trigger: "scheduled" });
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string; trigger: string };
    expect(body.trigger).toBe("scheduled");
    expect(body.error).toContain("POST /api/integrations/work-label/tick");
    expect(body.error).not.toContain("Synthetic");
  });
});
