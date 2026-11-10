import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OwnerCredentialError } from "@/server/owner-credential-store";

/**
 * Device sign-in routes: who may start a pairing, what the QR holds and where its origin comes from, the one-time
 * redeem, the RFC 8628-shaped code flow, and the web-view session. The store is mocked; its SQL is covered by the
 * integration suite.
 */
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => "postgres://test" }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
const store = vi.hoisted(() => ({
  startDevicePairing: vi.fn(),
  redeemDevicePairing: vi.fn(),
  startDeviceCode: vi.fn(),
  pollDeviceCode: vi.fn(),
  lookupDeviceCode: vi.fn(),
  decideDeviceCode: vi.fn(),
  openWebSession: vi.fn(),
  listCredentialEvents: vi.fn(),
  findOwnerCredentialByHash: vi.fn(),
  touchOwnerCredential: vi.fn(async () => false)
}));
vi.mock("@/server/owner-credential-store", async (original) => ({
  ...(await original<typeof import("@/server/owner-credential-store")>()),
  ...store
}));

const pairings = await import("./pairings/route");
const redeem = await import("./redeem/route");
const code = await import("./code/route");
const token = await import("./code/token/route");
const approve = await import("./code/approve/route");
const webSession = await import("../web-session/route");
const events = await import("../credential-events/route");

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const ID = "11111111-1111-4111-8111-111111111111";
const OWNER = "pri_own_desk-token";
const LIMITED = "pri_own_phone-token";
const INSTALL = "c0ffee00-1234-4abc-8def-0123456789ab";
let counter = 0;
/** A fresh address per request so one test's failures never throttle another's. */
const fresh = () => `10.0.${Math.floor(++counter / 250)}.${counter % 250}`;
const base = (headers: Record<string, string> = {}) => ({
  host: "portal.test",
  "content-type": "application/json",
  "x-forwarded-for": fresh(),
  ...headers
});
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://portal.test${path}`, { method: "POST", headers: base(headers), body: JSON.stringify(body) });
const ctx = undefined;
const live = (secret: string, over: Record<string, unknown> = {}) =>
  store.findOwnerCredentialByHash.mockImplementation(async (_sql: unknown, h: string) =>
    h === hash(secret)
      ? {
          id: ID,
          kind: "token",
          secretHash: h,
          expiresAt: null,
          revokedAt: null,
          limited: false,
          device: null,
          parentId: null,
          ...over
        }
      : null
  );
const summary = (over: Record<string, unknown> = {}) => ({
  id: ID,
  kind: "token",
  label: "Phone",
  createdAt: "2026-11-10T00:00:00.000Z",
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  device: { installId: INSTALL, platform: "ios" },
  limited: true,
  parentCredentialId: null,
  lastUsedFrom: null,
  ...over
});

beforeEach(() => {
  vi.stubEnv("PORTAL_PUBLIC_URL", "https://portal.test");
  vi.stubEnv("PORTAL_ALLOWED_HOSTS", "");
  for (const mock of Object.values(store)) mock.mockReset();
  store.touchOwnerCredential.mockResolvedValue(false);
  store.findOwnerCredentialByHash.mockResolvedValue(null);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/owner/devices/pairings", () => {
  beforeEach(() => {
    store.startDevicePairing.mockResolvedValue({
      id: ID,
      secret: "pri_pair_abc",
      expiresAt: new Date("2026-11-10T00:10:00Z")
    });
  });

  it("answers the QR text: the public origin from PORTAL_PUBLIC_URL and a one-time secret, nothing stored by the route", async () => {
    const response = await pairings.POST(post("/api/owner/devices/pairings", {}), ctx);
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { payload: string; origin: string; host: string; expiresAt: string };
    expect(JSON.parse(body.payload)).toEqual({ v: 1, origin: "https://portal.test", secret: "pri_pair_abc" });
    expect(body).toMatchObject({
      origin: "https://portal.test",
      host: "portal.test",
      expiresAt: "2026-11-10T00:10:00.000Z"
    });
  });

  it("never takes the origin from the Host header or from a typed value while PORTAL_PUBLIC_URL is set", async () => {
    const response = await pairings.POST(
      post("/api/owner/devices/pairings", { origin: "https://evil.example" }, { "x-forwarded-host": "evil.example" }),
      ctx
    );
    expect(JSON.parse(((await response.json()) as { payload: string }).payload).origin).toBe("https://portal.test");
  });

  it("asks for a typed https address when PORTAL_PUBLIC_URL is unset, and uses it for that one QR only", async () => {
    vi.stubEnv("PORTAL_PUBLIC_URL", "");
    vi.stubEnv("PORTAL_ALLOWED_HOSTS", "portal.test,phone.example.com");
    const asked = await pairings.POST(post("/api/owner/devices/pairings", {}), ctx);
    expect(asked.status).toBe(422);
    expect(await asked.json()).toMatchObject({ needsOrigin: true });
    expect(store.startDevicePairing).not.toHaveBeenCalled();
    const typed = await pairings.POST(
      post("/api/owner/devices/pairings", { origin: "https://phone.example.com" }),
      ctx
    );
    expect(typed.status).toBe(201);
    // The request's own Host was portal.test; the QR holds the typed address.
    expect(JSON.parse(((await typed.json()) as { payload: string }).payload).origin).toBe("https://phone.example.com");
  });

  it("shows no QR for an address a phone cannot use, and names the setting to add when the host is not accepted", async () => {
    vi.stubEnv("PORTAL_PUBLIC_URL", "");
    vi.stubEnv("PORTAL_ALLOWED_HOSTS", "portal.test");
    for (const origin of [
      "http://phone.example.com",
      "https://localhost:8787",
      "https://192.168.1.20",
      "https://portal",
      "https://phone.example.com/path",
      "not a url"
    ]) {
      const response = await pairings.POST(post("/api/owner/devices/pairings", { origin }), ctx);
      expect([400, 422], origin).toContain(response.status);
    }
    const unlisted = await pairings.POST(
      post("/api/owner/devices/pairings", { origin: "https://other.example.com" }),
      ctx
    );
    expect(unlisted.status).toBe(422);
    expect(((await unlisted.json()) as { error: string }).error).toContain("PORTAL_ALLOWED_HOSTS");
    expect(store.startDevicePairing).not.toHaveBeenCalled();
  });

  it("shows no QR when PORTAL_PUBLIC_URL itself is http", async () => {
    vi.stubEnv("PORTAL_PUBLIC_URL", "http://portal.test");
    const response = await pairings.POST(post("/api/owner/devices/pairings", {}), ctx);
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: string }).error).toContain("https");
  });

  it("refuses an agent identity, and under require needs a full owner credential", async () => {
    expect(
      (await pairings.POST(post("/api/owner/devices/pairings", {}, { "x-openrhen-agent": "companion" }), ctx)).status
    ).toBe(403);
    vi.stubEnv("OPENRHEN_OWNER_AUTH", "require");
    expect((await pairings.POST(post("/api/owner/devices/pairings", {}), ctx)).status).toBe(401);
    live(LIMITED, { limited: true });
    const limited = await pairings.POST(post("/api/owner/devices/pairings", {}, { "x-openrhen-owner": LIMITED }), ctx);
    expect(limited.status).toBe(403);
    expect(limited.headers.get("x-owner-reason")).toBe("limited-credential");
    expect(store.startDevicePairing).not.toHaveBeenCalled();
    live(OWNER);
    const ok = await pairings.POST(post("/api/owner/devices/pairings", {}, { "x-openrhen-owner": OWNER }), ctx);
    expect(ok.status).toBe(201);
    expect(store.startDevicePairing.mock.calls[0]![1]).toMatchObject({ actorId: ID });
  });

  it("works under owner auth off for any non-agent caller, as enrol does", async () => {
    vi.stubEnv("OPENRHEN_OWNER_AUTH", "off");
    expect((await pairings.POST(post("/api/owner/devices/pairings", {}), ctx)).status).toBe(201);
  });

  it("maps a store refusal (too many waiting) to its status", async () => {
    store.startDevicePairing.mockRejectedValue(new OwnerCredentialError(429, "Too many pairings are waiting."));
    expect((await pairings.POST(post("/api/owner/devices/pairings", {}), ctx)).status).toBe(429);
  });
});

describe("POST /api/owner/devices/redeem", () => {
  const body = { pairingSecret: "pri_pair_abc", name: "Phone", installId: INSTALL, platform: "ios" };

  it("trades the pairing secret for a limited owner token carrying the device, with no sign-in and no Origin", async () => {
    store.redeemDevicePairing.mockResolvedValue({ secret: "pri_own_new", summary: summary() });
    vi.stubEnv("OPENRHEN_OWNER_AUTH", "require");
    const response = await redeem.POST(post("/api/owner/devices/redeem", body), ctx);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      token: "pri_own_new",
      credential: { limited: true, device: { installId: INSTALL, platform: "ios" } }
    });
    expect(store.redeemDevicePairing.mock.calls[0]![1]).toMatchObject({
      secret: "pri_pair_abc",
      name: "Phone",
      device: { installId: INSTALL, platform: "ios" }
    });
  });

  it("refuses a wrong, spent or expired secret, and throttles the address that keeps guessing", async () => {
    store.redeemDevicePairing.mockResolvedValue(null);
    const address = { "x-forwarded-for": "203.0.113.77" };
    for (let i = 0; i < 10; i += 1)
      expect((await redeem.POST(post("/api/owner/devices/redeem", body, address), ctx)).status).toBe(400);
    const throttled = await redeem.POST(post("/api/owner/devices/redeem", body, address), ctx);
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("retry-after")).toBeTruthy();
  });

  it("validates the body: an install id must be a lowercase key, and an agent is refused", async () => {
    expect(
      (await redeem.POST(post("/api/owner/devices/redeem", { ...body, installId: "UPPER-CASE" }), ctx)).status
    ).toBe(400);
    expect((await redeem.POST(post("/api/owner/devices/redeem", {}), ctx)).status).toBe(400);
    expect(
      (await redeem.POST(post("/api/owner/devices/redeem", body, { "x-openrhen-agent": "companion" }), ctx)).status
    ).toBe(403);
    expect(store.redeemDevicePairing).not.toHaveBeenCalled();
  });
});

describe("the device code flow", () => {
  it("POST code: gives a device code and a typed code, and throttles an address that keeps asking", async () => {
    store.startDeviceCode.mockResolvedValue({
      deviceCode: "pri_dcode_x",
      userCode: "BCDF-GHJK",
      expiresAt: new Date(),
      interval: 5
    });
    const address = { "x-forwarded-for": "203.0.113.90" };
    const first = await code.POST(post("/api/owner/devices/code", { name: "Phone", installId: INSTALL }, address), ctx);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      deviceCode: "pri_dcode_x",
      userCode: "BCDF-GHJK",
      expiresIn: 600,
      interval: 5
    });
    for (let i = 0; i < 4; i += 1)
      await code.POST(post("/api/owner/devices/code", { name: "Phone", installId: INSTALL }, address), ctx);
    expect(
      (await code.POST(post("/api/owner/devices/code", { name: "Phone", installId: INSTALL }, address), ctx)).status
    ).toBe(429);
  });

  it("POST code: is open without sign-in under require, and says when too many codes already wait", async () => {
    vi.stubEnv("OPENRHEN_OWNER_AUTH", "require");
    store.startDeviceCode.mockRejectedValue(new OwnerCredentialError(429, "Too many pairings are waiting."));
    expect((await code.POST(post("/api/owner/devices/code", { name: "Phone", installId: INSTALL }), ctx)).status).toBe(
      429
    );
  });

  it("POST code/token: answers with RFC 8628's error names, each as HTTP 400", async () => {
    for (const error of ["authorization_pending", "slow_down", "expired_token", "access_denied"] as const) {
      store.pollDeviceCode.mockResolvedValueOnce({ kind: "error", error });
      const response = await token.POST(post("/api/owner/devices/code/token", { deviceCode: "pri_dcode_x" }), ctx);
      expect(response.status, error).toBe(400);
      expect(await response.json()).toEqual({ error });
    }
  });

  it("POST code/token: hands over the token once approved", async () => {
    store.pollDeviceCode.mockResolvedValue({ kind: "token", secret: "pri_own_new", summary: summary() });
    const response = await token.POST(post("/api/owner/devices/code/token", { deviceCode: "pri_dcode_x" }), ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ token: "pri_own_new", credential: { limited: true } });
  });

  it("POST code/token: an expired or unknown code counts against the failure throttle", async () => {
    store.pollDeviceCode.mockResolvedValue({ kind: "error", error: "expired_token" });
    const address = { "x-forwarded-for": "203.0.113.91" };
    for (let i = 0; i < 10; i += 1)
      await token.POST(post("/api/owner/devices/code/token", { deviceCode: "x" }, address), ctx);
    expect((await token.POST(post("/api/owner/devices/code/token", { deviceCode: "x" }, address), ctx)).status).toBe(
      429
    );
  });

  it("POST code/approve: looks a typed code up, then approves or denies it, recording the approving credential", async () => {
    vi.stubEnv("OPENRHEN_OWNER_AUTH", "require");
    live(OWNER);
    const headers = { "x-openrhen-owner": OWNER };
    const waiting = {
      name: "Phone",
      device: { installId: INSTALL, platform: "ios" },
      requestedAt: "2026-11-10T00:00:00.000Z",
      from: null
    };
    store.lookupDeviceCode.mockResolvedValue(waiting);
    const looked = await approve.POST(post("/api/owner/devices/code/approve", { userCode: "bcdf ghjk" }, headers), ctx);
    expect(looked.status).toBe(200);
    expect(await looked.json()).toEqual({ pending: waiting });
    expect(store.decideDeviceCode).not.toHaveBeenCalled();
    store.decideDeviceCode.mockResolvedValue(waiting);
    const approved = await approve.POST(
      post("/api/owner/devices/code/approve", { userCode: "BCDF-GHJK", decision: "approve" }, headers),
      ctx
    );
    expect(await approved.json()).toMatchObject({ decision: "approve" });
    expect(store.decideDeviceCode.mock.calls[0]!.slice(1, 3)).toEqual(["BCDF-GHJK", "approve"]);
    expect(store.decideDeviceCode.mock.calls[0]![3]).toMatchObject({ actorId: ID });
    await approve.POST(
      post("/api/owner/devices/code/approve", { userCode: "BCDF-GHJK", decision: "deny" }, headers),
      ctx
    );
    expect(store.decideDeviceCode.mock.calls[1]![2]).toBe("deny");
  });

  it("POST code/approve: needs a signed-in owner under require, refuses a limited one, and counts a wrong code", async () => {
    vi.stubEnv("OPENRHEN_OWNER_AUTH", "require");
    expect((await approve.POST(post("/api/owner/devices/code/approve", { userCode: "BCDF-GHJK" }), ctx)).status).toBe(
      401
    );
    live(LIMITED, { limited: true });
    const limited = await approve.POST(
      post(
        "/api/owner/devices/code/approve",
        { userCode: "BCDF-GHJK", decision: "approve" },
        { "x-openrhen-owner": LIMITED }
      ),
      ctx
    );
    expect(limited.status).toBe(403);
    live(OWNER);
    store.lookupDeviceCode.mockResolvedValue(null);
    const address = { "x-openrhen-owner": OWNER, "x-forwarded-for": "203.0.113.92" };
    for (let i = 0; i < 10; i += 1)
      expect(
        (await approve.POST(post("/api/owner/devices/code/approve", { userCode: "BBBB-BBBB" }, address), ctx)).status
      ).toBe(404);
    expect(
      (await approve.POST(post("/api/owner/devices/code/approve", { userCode: "BBBB-BBBB" }, address), ctx)).status
    ).toBe(429);
    expect(store.decideDeviceCode).not.toHaveBeenCalled();
  });
});

describe("POST /api/owner/web-session", () => {
  const request = (headers: Record<string, string>) =>
    new Request("http://portal.test/api/owner/web-session", {
      method: "POST",
      headers: { host: "portal.test", ...headers }
    });

  it("exchanges a device's header token for a web-view cookie, with no Origin, as a child of that device", async () => {
    live(LIMITED, { limited: true, device: { installId: INSTALL, platform: "ios" } });
    store.openWebSession.mockResolvedValue({
      secret: "pri_ses_child",
      summary: summary({ kind: "browser", parentCredentialId: ID, expiresAt: "2026-12-10T00:00:00.000Z" })
    });
    for (const mode of ["off", "shadow", "require"]) {
      vi.stubEnv("OPENRHEN_OWNER_AUTH", mode);
      const response = await webSession.POST(request({ "x-openrhen-owner": LIMITED }), ctx);
      expect(response.status, mode).toBe(201);
      const cookie = response.headers.get("set-cookie")!;
      expect(cookie).toContain("openrhen_owner=pri_ses_child");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      expect(await response.json()).toMatchObject({ session: { cookie: "openrhen_owner", value: "pri_ses_child" } });
    }
    expect(store.openWebSession.mock.calls[0]![1]).toBe(ID);
  });

  it("needs the header token: no credential, a cookie alone, an unknown or revoked token are all 401", async () => {
    expect((await webSession.POST(request({}), ctx)).status).toBe(401);
    live(LIMITED);
    expect((await webSession.POST(request({ cookie: "openrhen_owner=pri_ses_x" }), ctx)).status).toBe(401);
    expect((await webSession.POST(request({ "x-openrhen-owner": "pri_own_nope" }), ctx)).status).toBe(401);
    store.findOwnerCredentialByHash.mockImplementation(async (_sql: unknown, h: string) => ({
      id: ID,
      kind: "token",
      secretHash: h,
      expiresAt: null,
      revokedAt: new Date(),
      limited: true,
      device: null,
      parentId: null
    }));
    const revoked = await webSession.POST(request({ "x-openrhen-owner": LIMITED }), ctx);
    expect(revoked.status).toBe(401);
    expect(((await revoked.json()) as { error: string }).error).toContain("revoked");
    expect(store.openWebSession).not.toHaveBeenCalled();
  });

  it("is refused when the device credential is revoked between the check and the exchange", async () => {
    live(LIMITED, { limited: true });
    store.openWebSession.mockResolvedValue(null);
    expect((await webSession.POST(request({ "x-openrhen-owner": LIMITED }), ctx)).status).toBe(401);
  });
});

describe("GET /api/owner/credential-events", () => {
  it("lists the record for a signed-in owner and refuses an agent", async () => {
    store.listCredentialEvents.mockResolvedValue([{ id: ID, event: "redeemed" }]);
    const ask = (headers: Record<string, string> = {}) =>
      events.GET(
        new Request("http://portal.test/api/owner/credential-events", { headers: { host: "portal.test", ...headers } }),
        ctx
      );
    expect(await (await ask()).json()).toEqual({ events: [{ id: ID, event: "redeemed" }] });
    expect((await ask({ "x-openrhen-agent": "companion" })).status).toBe(403);
  });
});
