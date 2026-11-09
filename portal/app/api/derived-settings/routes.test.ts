import { beforeEach, describe, expect, it, vi } from "vitest";

/** The settings route's framing: validation answers 400 with the range and the fix, and no write happens on a bad body. */
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => "postgres://test" }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
const store = vi.hoisted(() => ({ readDerivedSettings: vi.fn(), saveDerivedSettings: vi.fn() }));
vi.mock("@/server/persistence/postgres/derived-settings-store", () => store);
const calls = vi.hoisted(() => ({ hostedUsageLast24Hours: vi.fn(), recordModelCall: vi.fn() }));
vi.mock("@/server/persistence/postgres/derived-model-calls-store", () => calls);
vi.mock("@/server/persistence/postgres/ensure-user", () => ({ ensureUser: async () => "u1" }));

const { GET, PUT } = await import("./route");

const put = (body: unknown, raw?: string) =>
  PUT(
    new Request("http://localhost/api/derived-settings", { method: "PUT", body: raw ?? JSON.stringify(body) }),
    undefined as never
  );

const saved = {
  ollamaUrl: "http://192.168.1.20:11434",
  t2Model: "qwen3:8b",
  t3Model: null,
  t3DailyMessageCap: 50,
  t3DailyTokenCap: 200_000,
  backfillDays: 90,
  updatedAt: "2026-11-08T00:00:00.000Z"
};

beforeEach(() => {
  calls.hostedUsageLast24Hours.mockReset();
  calls.hostedUsageLast24Hours.mockResolvedValue({ messages: 3, tokens: 1200 });
  store.readDerivedSettings.mockReset();
  store.saveDerivedSettings.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/derived-settings", () => {
  it("returns the settings, no-store, with the note that the hosted key lives under Passwords and keys", async () => {
    store.readDerivedSettings.mockResolvedValue(saved);
    const response = await GET(new Request("http://localhost/api/derived-settings"), undefined as never);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { settings: typeof saved; note: string };
    expect(body.settings).toEqual(saved);
    expect(body.note).toContain("Passwords and keys");
    expect(body.note).toContain("restore");
    expect(body.note).toContain("outbound proxy refuses loopback");
    expect(JSON.stringify(body).toLowerCase()).not.toContain("sk-");
  });

  it("returns the hosted sends and tokens of the last 24 hours for the card", async () => {
    store.readDerivedSettings.mockResolvedValue(saved);
    const response = await GET(new Request("http://localhost/api/derived-settings"), undefined as never);
    expect(((await response.json()) as { usage: unknown }).usage).toEqual({ messages: 3, tokens: 1200 });
  });
});

describe("PUT /api/derived-settings", () => {
  it("saves a valid patch and returns the merged settings", async () => {
    store.saveDerivedSettings.mockResolvedValue(saved);
    const response = await put({ ollamaUrl: " http://192.168.1.20:11434/ ", t2Model: "qwen3:8b", backfillDays: 30 });
    expect(response.status).toBe(200);
    expect(store.saveDerivedSettings.mock.calls[0]![1]).toEqual({
      ollamaUrl: "http://192.168.1.20:11434",
      t2Model: "qwen3:8b",
      backfillDays: 30
    });
    expect(((await response.json()) as { settings: typeof saved }).settings).toEqual(saved);
  });

  it("answers a bad body with a 400 naming the range and the fix, and writes nothing", async () => {
    const response = await put({ backfillDays: 5000, t3DailyMessageCap: -1, ollamaUrl: "http://u:p@10.0.0.1:11434" });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; problems: string[] };
    expect(body.problems).toHaveLength(3);
    expect(body.error).toContain("1 to 3650");
    expect(body.error).toContain("0 to 10000");
    expect(body.error).toContain("credentials");
    expect(body.error).not.toContain(":p@");
    expect(store.saveDerivedSettings).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON, an empty object and an unknown field", async () => {
    expect((await put(undefined, "not json")).status).toBe(400);
    expect((await put({})).status).toBe(400);
    const unknown = await put({ surprise: 1 });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toContain("surprise");
    expect(store.saveDerivedSettings).not.toHaveBeenCalled();
  });

  it("does not accept the hosted key, and says where it goes", async () => {
    const response = await put({ hostedModelApiKey: "abc" });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("Passwords and keys");
    expect(store.saveDerivedSettings).not.toHaveBeenCalled();
  });
});
