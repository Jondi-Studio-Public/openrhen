import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OwnerCredentialError } from "@/server/owner-credential-store";

/** The owner routes' framing: who may enrol, the cookie it sets, never a secret in a listing, and sign-out. */
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => "postgres://test" }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
const store = vi.hoisted(() => ({
  createOwnerCredential: vi.fn(),
  listOwnerCredentials: vi.fn(),
  revokeOwnerCredential: vi.fn(),
  findOwnerCredentialByHash: vi.fn(),
  touchOwnerCredential: vi.fn(async () => false)
}));
vi.mock("@/server/owner-credential-store", async (original) => ({
  ...(await original<typeof import("@/server/owner-credential-store")>()),
  ...store
}));

const enroll = await import("./enroll/route");
const session = await import("./session/route");
const credentials = await import("./credentials/route");
const item = await import("./credentials/[id]/route");
const signout = await import("./signout/route");

const ID = "11111111-1111-4111-8111-111111111111";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const base = { host: "portal.test", origin: "http://portal.test", "content-type": "application/json" };
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://portal.test${path}`, {
    method: "POST",
    headers: { ...base, ...headers },
    body: JSON.stringify(body)
  });
const stored = (kind: "token" | "browser", over = {}) => ({
  id: ID,
  kind,
  secretHash: hash("pri_own_x"),
  expiresAt: null,
  revokedAt: null,
  ...over
});

beforeEach(() => {
  // The default host allowlist is closed: admit the host these tests send.
  vi.stubEnv("PORTAL_PUBLIC_URL", "https://portal.test");
  for (const mock of Object.values(store)) mock.mockReset();
  store.touchOwnerCredential.mockResolvedValue(false);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/owner/enroll", () => {
  it("enrols a browser while auth is off and sets a strict, HttpOnly cookie (the bootstrap)", async () => {
    store.createOwnerCredential.mockResolvedValue({ secret: "pri_ses_abc", summary: { id: ID, kind: "browser" } });
    const response = await enroll.POST(post("/api/owner/enroll", { label: "Laptop" }), undefined);
    expect(response.status).toBe(201);
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toContain("openrhen_owner=pri_ses_abc");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(JSON.stringify(await response.json())).not.toContain("pri_ses_abc");
    expect(store.createOwnerCredential.mock.calls[0]!.slice(1)).toEqual(["browser", "Laptop"]);
  });

  it("refuses an agent identity and a request from another origin", async () => {
    expect(
      (await enroll.POST(post("/api/owner/enroll", {}, { "x-openrhen-agent": "companion" }), undefined)).status
    ).toBe(403);
    expect((await enroll.POST(post("/api/owner/enroll", {}, { origin: "http://evil.test" }), undefined)).status).toBe(
      403
    );
    expect(store.createOwnerCredential).not.toHaveBeenCalled();
  });

  it("under require, needs a credential or a valid secret, and the recovery token works", async () => {
    vi.stubEnv("OPENRHEN_OWNER_AUTH", "require");
    vi.stubEnv("OWNER_RECOVERY_TOKEN", hash("recover-me"));
    store.createOwnerCredential.mockResolvedValue({ secret: "pri_ses_abc", summary: { id: ID, kind: "browser" } });
    store.findOwnerCredentialByHash.mockResolvedValue(null);
    expect((await enroll.POST(post("/api/owner/enroll", {}), undefined)).status).toBe(401);
    expect((await enroll.POST(post("/api/owner/enroll", { secret: "guess" }), undefined)).status).toBe(401);
    expect((await enroll.POST(post("/api/owner/enroll", { secret: "recover-me" }), undefined)).status).toBe(201);
    store.findOwnerCredentialByHash.mockResolvedValue(stored("token"));
    expect((await enroll.POST(post("/api/owner/enroll", { secret: "pri_own_x" }), undefined)).status).toBe(201);
  });

  it("under require, a stale cookie does not get in the way of the recovery token, and the new cookie wins", async () => {
    vi.stubEnv("OPENRHEN_OWNER_AUTH", "require");
    vi.stubEnv("OWNER_RECOVERY_TOKEN", hash("recover-me"));
    store.findOwnerCredentialByHash.mockResolvedValue(null);
    store.createOwnerCredential.mockResolvedValue({ secret: "pri_ses_abc", summary: { id: ID, kind: "browser" } });
    for (let i = 0; i < 12; i += 1)
      expect(
        (await enroll.POST(post("/api/owner/enroll", {}, { cookie: `openrhen_owner=stale-${i}` }), undefined)).status
      ).toBe(401);
    const response = await enroll.POST(
      post("/api/owner/enroll", { secret: "recover-me" }, { cookie: "openrhen_owner=stale" }),
      undefined
    );
    expect(response.status).toBe(201);
  });

  it("under require, a browser that is already signed in may enrol another without a secret", async () => {
    vi.stubEnv("OPENRHEN_OWNER_AUTH", "require");
    store.findOwnerCredentialByHash.mockResolvedValue(stored("browser", { secretHash: hash("pri_ses_old") }));
    store.createOwnerCredential.mockResolvedValue({ secret: "pri_ses_new", summary: { id: ID, kind: "browser" } });
    const response = await enroll.POST(
      post("/api/owner/enroll", {}, { cookie: "openrhen_owner=pri_ses_old" }),
      undefined
    );
    expect(response.status).toBe(201);
  });

  it("maps the browser cap to a 409", async () => {
    store.createOwnerCredential.mockRejectedValue(new OwnerCredentialError(409, "20 browsers are already enrolled"));
    expect((await enroll.POST(post("/api/owner/enroll", {}), undefined)).status).toBe(409);
  });
});

describe("a limited device credential", () => {
  const LIMITED_ID = "22222222-2222-4222-8222-222222222222";
  const PARENT_ID = "33333333-3333-4333-8333-333333333333";
  const limited = (over: Record<string, unknown> = {}) =>
    stored("token", { id: LIMITED_ID, secretHash: hash("pri_own_phone"), limited: true, ...over });
  const del = (id: string, headers: Record<string, string>) =>
    item.DELETE(
      new Request(`http://portal.test/api/owner/credentials/${id}`, {
        method: "DELETE",
        headers: { ...base, ...headers }
      }),
      { params: Promise.resolve({ id }) }
    );

  it("cannot enrol a browser: refused as the held credential, and refused as the secret", async () => {
    vi.stubEnv("OPENRHEN_OWNER_AUTH", "require");
    store.findOwnerCredentialByHash.mockResolvedValue(limited());
    const held = await enroll.POST(post("/api/owner/enroll", {}, { "x-openrhen-owner": "pri_own_phone" }), undefined);
    expect(held.status).toBe(403);
    expect(held.headers.get("x-owner-reason")).toBe("limited-credential");
    // As the secret, from a caller with no credential of its own.
    const asSecret = await enroll.POST(post("/api/owner/enroll", { secret: "pri_own_phone" }), undefined);
    expect(asSecret.status).toBe(403);
    expect(store.createOwnerCredential).not.toHaveBeenCalled();
  });

  it("cannot mint an owner token", async () => {
    vi.stubEnv("OPENRHEN_OWNER_AUTH", "require");
    store.findOwnerCredentialByHash.mockResolvedValue(limited());
    const response = await credentials.POST(
      post("/api/owner/credentials", { label: "x" }, { "x-openrhen-owner": "pri_own_phone" }),
      undefined
    );
    expect(response.status).toBe(403);
    expect(store.createOwnerCredential).not.toHaveBeenCalled();
  });

  it("may revoke itself or the device it is the web view of, but no other credential", async () => {
    vi.stubEnv("OPENRHEN_OWNER_AUTH", "require");
    store.revokeOwnerCredential.mockResolvedValue({ id: LIMITED_ID });
    store.findOwnerCredentialByHash.mockResolvedValue(limited());
    const headers = { "x-openrhen-owner": "pri_own_phone" };
    expect((await del(LIMITED_ID, headers)).status).toBe(200);
    const elsewhere = await del(ID, headers);
    expect(elsewhere.status).toBe(403);
    expect(store.revokeOwnerCredential).toHaveBeenCalledTimes(1);
    // Its web view: a browser-kind child, which may revoke its parent device.
    store.findOwnerCredentialByHash.mockResolvedValue(
      stored("browser", { id: LIMITED_ID, secretHash: hash("pri_ses_view"), limited: true, parentId: PARENT_ID })
    );
    const cookie = { cookie: "openrhen_owner=pri_ses_view" };
    expect((await del(PARENT_ID, cookie)).status).toBe(200);
    expect((await del(ID, cookie)).status).toBe(403);
  });

  it("is named by the session route, so the Devices page can hide what it would refuse", async () => {
    vi.stubEnv("OPENRHEN_OWNER_AUTH", "require");
    store.findOwnerCredentialByHash.mockResolvedValue(limited());
    const response = await session.GET(
      new Request("http://portal.test/api/owner/session", { headers: { "x-openrhen-owner": "pri_own_phone" } }),
      undefined
    );
    expect(await response.json()).toMatchObject({ signedIn: true, limited: true });
  });

  it("canManage is false for a limited credential", async () => {
    vi.stubEnv("OPENRHEN_OWNER_AUTH", "require");
    store.findOwnerCredentialByHash.mockResolvedValue(limited());
    const response = await session.GET(
      new Request("http://portal.test/api/owner/session", { headers: { "x-openrhen-owner": "pri_own_phone" } }),
      undefined
    );
    expect(await response.json()).toMatchObject({ limited: true, canManage: false });
  });

  it("records who revoked what: the revoking credential and the address", async () => {
    vi.stubEnv("OPENRHEN_OWNER_AUTH", "require");
    store.revokeOwnerCredential.mockResolvedValue({ id: ID });
    store.findOwnerCredentialByHash.mockResolvedValue(stored("token"));
    await del(ID, { "x-openrhen-owner": "pri_own_x", "x-forwarded-for": "203.0.113.5" });
    expect(store.revokeOwnerCredential.mock.calls[0]![3]).toEqual({ actorId: ID, address: "203.0.113.5" });
  });
});

describe("GET /api/owner/session", () => {
  const get = (headers: Record<string, string> = {}) =>
    session.GET(new Request("http://portal.test/api/owner/session", { headers }), undefined);

  it("says the mode and whether this request is signed in", async () => {
    expect(await (await get()).json()).toEqual({ mode: "off", signedIn: false, via: null, canManage: true });
    vi.stubEnv("OPENRHEN_OWNER_AUTH", "require");
    expect(await (await get()).json()).toMatchObject({ mode: "require", signedIn: false, canManage: false });
    store.findOwnerCredentialByHash.mockResolvedValue(stored("token"));
    expect(await (await get({ "x-openrhen-owner": "pri_own_x" })).json()).toMatchObject({
      signedIn: true,
      via: "header",
      canManage: true
    });
  });
});

describe("credentials", () => {
  const list = (headers: Record<string, string> = {}) =>
    credentials.GET(new Request("http://portal.test/api/owner/credentials", { headers }), undefined);

  it("lists with the current one marked, and refuses a named agent", async () => {
    store.findOwnerCredentialByHash.mockResolvedValue(stored("token"));
    store.listOwnerCredentials.mockResolvedValue([
      { id: ID, kind: "token" },
      { id: "other", kind: "browser" }
    ]);
    const body = await (await list({ "x-openrhen-owner": "pri_own_x" })).json();
    expect(body.credentials.map((c: { current: boolean }) => c.current)).toEqual([true, false]);
    expect((await list({ "x-openrhen-agent": "companion" })).status).toBe(403);
  });

  it("creates an owner token once, with no-store", async () => {
    store.createOwnerCredential.mockResolvedValue({ secret: "pri_own_new", summary: { id: ID, kind: "token" } });
    const response = await credentials.POST(post("/api/owner/credentials", { label: "CLI" }), undefined);
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).token).toBe("pri_own_new");
  });

  it("revokes by id, 404s a malformed or unknown id, and refuses an agent", async () => {
    store.revokeOwnerCredential.mockResolvedValue({ id: ID });
    const del = (id: string, headers: Record<string, string> = {}) =>
      item.DELETE(
        new Request(`http://portal.test/api/owner/credentials/${id}`, {
          method: "DELETE",
          headers: { ...base, ...headers }
        }),
        {
          params: Promise.resolve({ id })
        }
      );
    expect((await del(ID)).status).toBe(200);
    expect((await del("nope")).status).toBe(404);
    store.revokeOwnerCredential.mockRejectedValue(new OwnerCredentialError(404, "That credential does not exist."));
    expect((await del(ID)).status).toBe(404);
    expect((await del(ID, { "x-openrhen-agent": "companion" })).status).toBe(403);
  });
});

describe("POST /api/owner/signout", () => {
  it("revokes the session behind the cookie and clears it", async () => {
    store.findOwnerCredentialByHash.mockResolvedValue(stored("browser", { secretHash: hash("pri_ses_old") }));
    store.revokeOwnerCredential.mockResolvedValue({ id: ID });
    const response = await signout.POST(
      post("/api/owner/signout", {}, { cookie: "openrhen_owner=pri_ses_old" }),
      undefined
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(store.revokeOwnerCredential).toHaveBeenCalledWith(expect.anything(), ID);
  });

  it("still clears the cookie when there is nothing to revoke", async () => {
    const response = await signout.POST(post("/api/owner/signout", {}), undefined);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(store.revokeOwnerCredential).not.toHaveBeenCalled();
  });
});
