import { beforeEach, describe, expect, it, vi } from "vitest";

/** The Test button's route: validates the tier, runs the fixed-text test with the saved settings, never echoes a key. */
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => "postgres://test" }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
vi.mock("@/server/persistence/postgres/ensure-user", () => ({ ensureUser: async () => "u1" }));
const store = vi.hoisted(() => ({ readDerivedSettings: vi.fn() }));
vi.mock("@/server/persistence/postgres/derived-settings-store", () => store);
vi.mock("@/server/persistence/postgres/derived-model-calls-store", () => ({
  hostedUsageLast24Hours: async () => ({ messages: 0, tokens: 0 }),
  recordModelCall: async () => {}
}));
const run = vi.hoisted(() => vi.fn());
vi.mock("@/server/derived/connection-test", () => ({ runConnectionTest: run }));
const transport = vi.hoisted(() => vi.fn());
vi.mock("@/integrations/models/model-proxy-client", () => ({ createModelTransport: transport }));

const { POST } = await import("./route");

const post = (body: unknown, raw?: string) =>
  POST(
    new Request("http://localhost/api/derived-settings/test", { method: "POST", body: raw ?? JSON.stringify(body) }),
    undefined as never
  );

const settings = {
  ollamaUrl: "http://192.168.1.20:11434",
  t2Model: "qwen3:8b",
  t3Model: "Qwen/Qwen3-14B",
  t3DailyMessageCap: 50,
  t3DailyTokenCap: 200_000,
  backfillDays: 90,
  updatedAt: null
};

beforeEach(() => {
  run.mockReset();
  transport.mockReset();
  store.readDerivedSettings.mockReset();
  store.readDerivedSettings.mockResolvedValue(settings);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/derived-settings/test", () => {
  it("tests the local tier with the saved model and address", async () => {
    run.mockResolvedValue({ ok: true, tier: "t2", model: "qwen3:8b", ms: 900, tokensIn: 5, tokensOut: 4 });
    const response = await post({ tier: "t2" });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(run.mock.calls[0]![1]).toBe("t2");
    expect(run.mock.calls[0]![2]).toBe("qwen3:8b");
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", localAddress: "http://192.168.1.20:11434" })
    );
    expect(((await response.json()) as { result: { ok: boolean } }).result.ok).toBe(true);
  });

  it("tests the hosted tier with the saved hosted model", async () => {
    run.mockResolvedValue({ ok: false, tier: "t3", outcome: "bad_key", message: "No DeepInfra key is saved.", ms: 1 });
    const response = await post({ tier: "t3" });
    expect(response.status).toBe(200);
    expect(run.mock.calls[0]![2]).toBe("Qwen/Qwen3-14B");
    expect(((await response.json()) as { result: { message: string } }).result.message).toContain("key");
  });

  it("refuses an unknown tier and a body that is not JSON, running nothing", async () => {
    expect((await post({ tier: "t1" })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post(undefined, "nope")).status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });
});
