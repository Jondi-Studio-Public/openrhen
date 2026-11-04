import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The route's framing: headers, who the viewer is, `since` refusals, the counts mode and the post-gate 428. */
vi.mock("@/server/agent-tokens", () => ({
  identifyRequest: async (request: Request) => {
    const name = request.headers.get("x-openrhen-agent");
    return name ? { actor: name } : {};
  }
}));
vi.mock("@/server/owner-credential-store", () => ({ findOwnerCredentialByHash: async () => null }));
const env = vi.hoisted(() => ({ url: "postgres://test" as string | undefined }));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => env.url }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
vi.mock("@/server/pulse/reentry-gate", () => ({ reentryGate: async () => null }));
const feed = vi.hoisted(() => ({ read: vi.fn(), counts: vi.fn() }));
vi.mock("@/server/attention/read-attention", () => ({ readAttention: feed.read }));
vi.mock("@/server/attention/counts", () => ({ readAttentionCounts: feed.counts }));

const { GET } = await import("./route");

const ANSWER = { generatedAt: "2026-11-04T12:00:00.000Z", items: [], counts: { now: 0, soon: 0, fyi: 0 } };
const get = (query = "", headers: Record<string, string> = {}) =>
  GET(new Request(`http://portal.test/api/attention${query}`, { headers }), undefined);

beforeEach(() => {
  env.url = "postgres://test";
  feed.read.mockReset().mockResolvedValue({ answer: ANSWER });
  feed.counts.mockReset().mockResolvedValue({ viewer: "agent", healthBlocking: 1, sourcesFailed: 0, decided: 2 });
  vi.stubEnv("PORTAL_PUBLIC_URL", "https://portal.test");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/attention", () => {
  it("is never cached, and says the answer varies by who asks", async () => {
    const response = await get("", { "x-openrhen-agent": "scribe" });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie, Authorization, X-OpenRhen-Token, X-OpenRhen-Agent");
    expect(await response.json()).toEqual(ANSWER);
    const counts = await get("?counts=1", { "x-openrhen-agent": "scribe" });
    expect(counts.headers.get("cache-control")).toBe("private, no-store");
    expect(counts.headers.get("vary")).toContain("X-OpenRhen-Agent");
  });

  it("serves the agent view to a header-only name (unscoped) and the owner view to a caller with no name", async () => {
    await get("", { "x-openrhen-agent": "companion" });
    expect(feed.read.mock.calls[0]![1]).toEqual({ agent: "companion", scopes: undefined, since: undefined });
    await get("");
    expect(feed.read.mock.calls[1]![1]).toEqual({ agent: null, scopes: undefined, since: undefined });
  });

  it("passes a valid since on as UTC", async () => {
    await get("?since=2026-11-04T10:00:00%2B02:00", { "x-openrhen-agent": "scribe" });
    expect(feed.read.mock.calls[0]![1]).toMatchObject({ since: "2026-11-04T08:00:00.000Z" });
  });

  it("refuses a malformed since with 400 and the exact fix, and reads nothing", async () => {
    const response = await get("?since=yesterday", { "x-openrhen-agent": "scribe" });
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("2026-11-13T17:00:00-05:00");
    expect(body.error).toContain("status.now");
    expect(feed.read).not.toHaveBeenCalled();
    expect(feed.counts).not.toHaveBeenCalled();
  });

  it("answers only the counts for ?counts=1, from this request's agent and scopes", async () => {
    const response = await get("?counts=1", { "x-openrhen-agent": "scribe" });
    expect(await response.json()).toEqual({ viewer: "agent", healthBlocking: 1, sourcesFailed: 0, decided: 2 });
    expect(feed.counts.mock.calls[0]![1]).toMatchObject({ agent: "scribe" });
    expect(feed.read).not.toHaveBeenCalled();
  });

  it("answers the gate's 428 body, with no feed, when the pulse lapses after the gate", async () => {
    feed.read.mockResolvedValue({ lapsed: Response.json({ code: "reentryRequired" }, { status: 428 }) });
    const response = await get("", { "x-openrhen-agent": "scribe" });
    expect(response.status).toBe(428);
    expect(await response.json()).toEqual({ code: "reentryRequired" });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("says so when the portal has no database", async () => {
    env.url = undefined;
    expect((await get("", { "x-openrhen-agent": "scribe" })).status).toBe(503);
  });

  it("answers an anonymous caller 401 under OPENRHEN_OWNER_AUTH=require, and a name-only caller too", async () => {
    vi.stubEnv("OPENRHEN_OWNER_AUTH", "require");
    expect((await get("")).status).toBe(401);
    expect((await get("", { "x-openrhen-agent": "companion" })).status).toBe(401);
    expect(feed.read).not.toHaveBeenCalled();
  });
});
