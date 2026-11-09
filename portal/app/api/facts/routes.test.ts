import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Who a mark on a mail item is recorded as (slice 2b-9, S8): only an authenticated agent token names the agent. A caller
 * with no token (the owner's session) or with a bare agent label is refused and nothing is written; a body that names
 * who is acting is refused whatever the token.
 */
const identity = vi.hoisted(() => ({
  current: {} as { actor?: string; principal?: { source: string; name: string } }
}));
vi.mock("@/server/agent-tokens", () => ({ identifyRequest: async () => identity.current }));
vi.mock("@/server/owner-credential-store", () => ({ findOwnerCredentialByHash: async () => null }));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => "postgres://test" }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
vi.mock("@/server/pulse/reentry-gate", () => ({ reentryGate: async () => null }));
const store = vi.hoisted(() => ({ act: vi.fn(), list: vi.fn() }));
vi.mock("@/server/persistence/postgres/fact-listing-store", () => ({
  FACT_LISTING_LIMIT_DEFAULT: 20,
  readFactListing: store.list
}));
vi.mock("@/server/persistence/postgres/fact-act-store", () => ({ actOnFact: store.act }));

const { POST } = await import("./[id]/route");
const { GET } = await import("./route");

const ID = "a".repeat(40);
const post = (body: unknown) =>
  POST(
    new Request(`http://portal.test/api/facts/${ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }),
    { params: Promise.resolve({ id: ID }) }
  );

beforeEach(() => {
  identity.current = {};
  store.act.mockReset().mockResolvedValue({ ok: true, act: "done", dryRun: false, replay: false, message: "Closed." });
  vi.stubEnv("PORTAL_PUBLIC_URL", "https://portal.test");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.unstubAllEnvs());

describe("the refusals name the exact next call", () => {
  const agent = { actor: "mark", principal: { source: "env", name: "mark" } };
  const raw = (body: string) =>
    POST(
      new Request(`http://portal.test/api/facts/${ID}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body
      }),
      { params: Promise.resolve({ id: ID }) }
    );
  const errorOf = async (response: Response) => ((await response.json()) as { error: string }).error;

  it("tells a caller of POST what to send instead", async () => {
    identity.current = agent;
    const cases: [Response, string][] = [
      [await raw("[1]"), 'rhen_inbox_act {"room":"facts","action":"done"'],
      [await raw("not json"), 'rhen_inbox_act {"room":"facts","action":"done"'],
      [await post({}), 'rhen_inbox_act {"room":"facts","action":"confirm","id":"<id>"}'],
      [await post({ action: "done", set: "x" }), '"set":["days=14"]'],
      [await post({ action: "done", commandId: "nope" }), '"command-id"'],
      [await post({ action: "done", dryRun: "yes" }), '"dry-run":true'],
      [await post({ action: "done", extra: 1 }), 'rhen_inbox_act {"room":"facts","action":"<action>","id":"<id>"}']
    ];
    for (const [response, call] of cases) {
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toContain(call);
    }
    expect(store.act).not.toHaveBeenCalled();
  });

  it("tells the caller what to call when a read is refused", async () => {
    const listCall = 'rhen_inbox {"room":"facts"}';
    const bad = await GET(new Request("http://portal.test/api/facts?limit=0"), undefined);
    expect(bad.status).toBe(400);
    expect(await errorOf(bad)).toContain(listCall);
  });
});

describe("GET /api/facts", () => {
  const get = () => GET(new Request("http://portal.test/api/facts"), undefined);
  beforeEach(() => store.list.mockReset().mockResolvedValue({ total: 0, facts: [], marks: [], marksTotal: 0 }));

  it("offers marking only to an authenticated agent, never a bare label or the owner", async () => {
    identity.current = { actor: "mark" };
    expect(await (await get()).json()).toMatchObject({ canAct: false });
    identity.current = {};
    expect(await (await get()).json()).toMatchObject({ canAct: false });
    identity.current = { actor: "mark", principal: { source: "env", name: "mark" } };
    expect(await (await get()).json()).toMatchObject({ canAct: true });
  });
});

describe("POST /api/facts/[id]", () => {
  it("refuses a caller with no agent identity and writes nothing", async () => {
    const response = await post({ action: "done" });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "no_agent" });
    expect(store.act).not.toHaveBeenCalled();
  });

  it("refuses a bare agent label, which is a name and not a credential", async () => {
    identity.current = { actor: "mark" };
    const response = await post({ action: "done" });
    expect(response.status).toBe(403);
    expect(store.act).not.toHaveBeenCalled();
  });

  it("records the mark under the authenticated agent's name", async () => {
    identity.current = { actor: "mark", principal: { source: "env", name: "mark" } };
    const response = await post({ action: "done", set: {} });
    expect(response.status).toBe(200);
    expect(store.act.mock.calls[0]![1]).toBe("mark");
    expect(await response.json()).toMatchObject({ ok: true, message: "Closed." });
  });

  it("refuses a body that names who is acting, and any other field", async () => {
    identity.current = { actor: "mark", principal: { source: "env", name: "mark" } };
    for (const extra of [{ by: "human" }, { actor: "human" }, { ingestedVia: null }]) {
      const response = await post({ action: "done", ...extra });
      expect(response.status).toBe(400);
      const text = JSON.stringify(await response.json());
      expect(text).toContain("taken from the token");
      expect(text).toContain("X-OpenRhen-Basis");
    }
    expect(store.act).not.toHaveBeenCalled();
  });

  it("answers a refusal with the planner's code and words, and a busy answer as 409", async () => {
    identity.current = { actor: "mark", principal: { source: "env", name: "mark" } };
    store.act.mockResolvedValueOnce({ ok: false, code: "needs_stated", message: "done needs the owner's words." });
    const needs = await post({ action: "done" });
    expect(needs.status).toBe(400);
    expect(await needs.json()).toEqual({ code: "needs_stated", error: "done needs the owner's words." });
    store.act.mockResolvedValueOnce({ ok: false, code: "busy", message: "Busy." });
    expect((await post({ action: "done" })).status).toBe(409);
  });
});
