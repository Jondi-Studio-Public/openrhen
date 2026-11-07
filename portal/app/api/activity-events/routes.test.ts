import { beforeEach, describe, expect, it, vi } from "vitest";

/** The ingest route's framing: whole-request errors, the shorthand, the plain-English message, and what the store is told. */
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => "postgres://test" }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
const store = vi.hoisted(() => {
  class ActivityInputError extends Error {
    constructor(
      message: string,
      readonly status: 400 | 404 = 400
    ) {
      super(message);
    }
  }
  return { ActivityInputError, ingestActivityEvents: vi.fn(), readActivityEvents: vi.fn() };
});
vi.mock("@/server/persistence/postgres/activity-store", () => store);
vi.mock("@/server/agent-activity", () => ({ noteAgentCall: () => {} }));

const route = await import("./route");

const result = (extra: Record<string, unknown> = {}) => ({
  schema: 1,
  added: 1,
  alreadyHeld: 0,
  contentDropped: 0,
  rejected: [],
  importId: null,
  ingestedVia: "phone",
  ...extra
});
const post = (body: unknown, agent = "phone") =>
  route.POST(
    new Request("http://localhost/api/activity-events", {
      method: "POST",
      headers: { "content-type": "application/json", "x-openrhen-agent": agent },
      body: typeof body === "string" ? body : JSON.stringify(body)
    }),
    undefined
  );

beforeEach(() => {
  store.ingestActivityEvents.mockReset();
  store.readActivityEvents.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/activity-events", () => {
  it("stores a batch under the agent's name and says in plain words what happened", async () => {
    store.ingestActivityEvents.mockResolvedValue(result({ added: 2, alreadyHeld: 1, contentDropped: 1 }));
    const response = await post({ schema: 1, events: [{ id: "a" }] });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.message).toBe(
      "Saved 2 events; 1 already held; text dropped from 1 (the content gate for that source is off)."
    );
    expect(body).toMatchObject({ added: 2, alreadyHeld: 1, contentDropped: 1, rejected: [] });
    const [, batch, via] = store.ingestActivityEvents.mock.calls[0]!;
    expect(batch.events).toEqual([{ id: "a" }]);
    expect(via).toBe("phone");
  });

  it("takes the single-event shorthand, hashing an id when none is sent", async () => {
    store.ingestActivityEvents.mockResolvedValue(result());
    const response = await post({ source: "iphone-shortcuts", kind: "wake", start: "2026-11-07T06:00:00+11:00" });
    expect(response.status).toBe(200);
    const [, batch] = store.ingestActivityEvents.mock.calls[0]!;
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0].id).toMatch(/^h:/);
  });

  it("passes a shorthand id through as the key", async () => {
    store.ingestActivityEvents.mockResolvedValue(result());
    await post({ id: "k-1", source: "iphone-shortcuts", kind: "wake", start: "2026-11-07T06:00:00+11:00" });
    expect(store.ingestActivityEvents.mock.calls[0]![1].events[0].id).toBe("k-1");
  });

  it("fails a single shorthand event that was rejected, with the reason as the error", async () => {
    store.ingestActivityEvents.mockResolvedValue(
      result({
        added: 0,
        rejected: [{ index: 0, reason: 'kind "x" is not known for source "iphone-shortcuts". Use one of: wake.' }]
      })
    );
    const response = await post({ source: "iphone-shortcuts", kind: "x", start: "2026-11-07T06:00:00Z" });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/Use one of: wake/);
    expect(body.message).toMatch(/1 rejected/);
  });

  it("keeps a rejected event in a batch as a 200 with the per-event verdict", async () => {
    store.ingestActivityEvents.mockResolvedValue(result({ rejected: [{ index: 1, reason: "no" }] }));
    const response = await post({ schema: 1, events: [{}, {}] });
    expect(response.status).toBe(200);
    expect((await response.json()).rejected).toEqual([{ index: 1, reason: "no" }]);
  });

  it("answers malformed JSON, a wrong schema and an empty list with plain 400s, without touching the store", async () => {
    const notJson = await post("{nope");
    expect(notJson.status).toBe(400);
    expect((await notJson.json()).error).toMatch(/not valid JSON/);
    const version = await post({ schema: 2, events: [{}] });
    expect(version.status).toBe(400);
    expect((await version.json()).error).toMatch(/"schema": 1/);
    expect((await post({ schema: 1, events: [] })).status).toBe(400);
    expect(store.ingestActivityEvents).not.toHaveBeenCalled();
  });

  it("refuses an oversized body with 413 saying how many events to send", async () => {
    const response = await post(`{"schema":1,"events":[${"0,".repeat(1_100_000)}0]}`);
    expect(response.status).toBe(413);
    expect((await response.json()).error).toMatch(/at most 1000/);
    expect(store.ingestActivityEvents).not.toHaveBeenCalled();
  });

  it("answers an import the caller does not hold with the store's message and status", async () => {
    store.ingestActivityEvents.mockRejectedValue(
      new store.ActivityInputError("importId is not an import you hold.", 404)
    );
    const response = await post({ schema: 1, importId: "6f1d0a4e-8c3b-4f7a-9d2e-1b5c7a9e3f10", events: [{}] });
    expect(response.status).toBe(404);
  });
});

describe("GET /api/activity-events", () => {
  const get = (query: string) => route.GET(new Request(`http://localhost/api/activity-events${query}`), undefined);

  it("reads a page with the filters parsed, never cached", async () => {
    store.readActivityEvents.mockResolvedValue({ events: [], next: null });
    const response = await get("?source=spotify&kind=play&from=2026-11-01T00:00:00Z&limit=50");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(store.readActivityEvents.mock.calls[0]![1]).toMatchObject({
      source: "spotify",
      kind: "play",
      from: new Date("2026-11-01T00:00:00Z"),
      limit: 50
    });
  });

  it("answers a bad time or limit with a 400 that says what to send", async () => {
    expect((await get("?from=yesterday")).status).toBe(400);
    const limit = await get("?limit=5000");
    expect(limit.status).toBe(400);
    expect((await limit.json()).error).toMatch(/1 to 1000/);
  });
});
