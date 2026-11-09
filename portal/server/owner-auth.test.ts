import "@/test/example-calendar-sources";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFailureThrottle } from "./agent-token-throttle";
import type { AgentPrincipal } from "./agent-tokens";
import {
  matchesRecovery,
  matchesDevice,
  matchesWorker,
  ownerAuthMode,
  ownerCookie,
  ownerGate,
  sameOrigin,
  verifyEnrollSecret,
  verifyOwnerCredential,
  type OwnerDeps
} from "./owner-auth";
import type { StoredOwnerCredential } from "./owner-credential-store";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const NOW = new Date("2026-10-19T12:00:00Z");

let counter = 0;
function store(kind: "token" | "browser", secret: string, over: Partial<StoredOwnerCredential> = {}) {
  const credential: StoredOwnerCredential = {
    id: `cred-${++counter}`,
    kind,
    secretHash: hash(secret),
    expiresAt: null,
    revokedAt: null,
    ...over
  };
  const lookup = vi.fn(async (h: string) => (h === credential.secretHash ? credential : null));
  const touch = vi.fn(async () => false);
  const deps: OwnerDeps = { lookup, touch, throttle: createFailureThrottle(), now: () => NOW };
  return { credential, deps, lookup, touch };
}
const req = (headers: Record<string, string>, method = "GET", url = "http://portal.test/api/x") =>
  new Request(url, { method, headers });

afterEach(() => vi.unstubAllEnvs());

describe("verifyOwnerCredential", () => {
  it("sees nothing when no credential is presented", async () => {
    expect(await verifyOwnerCredential(req({}), store("token", "a").deps)).toEqual({ kind: "none" });
  });

  it("accepts an owner token in the header and a session in the cookie", async () => {
    const t = store("token", "pri_own_x");
    expect(await verifyOwnerCredential(req({ "x-openrhen-owner": "pri_own_x" }), t.deps)).toMatchObject({
      kind: "ok",
      via: "header"
    });
    const b = store("browser", "pri_ses_y");
    expect(await verifyOwnerCredential(req({ cookie: "a=1; openrhen_owner=pri_ses_y" }), b.deps)).toMatchObject({
      kind: "ok",
      via: "cookie"
    });
  });

  it("does not accept a browser session as a header, or a token as a cookie", async () => {
    const b = store("browser", "pri_ses_y");
    expect(await verifyOwnerCredential(req({ "x-openrhen-owner": "pri_ses_y" }), b.deps)).toMatchObject({
      kind: "invalid",
      status: 401
    });
    const t = store("token", "pri_own_x");
    expect(await verifyOwnerCredential(req({ cookie: "openrhen_owner=pri_own_x" }), t.deps)).toMatchObject({
      kind: "invalid",
      status: 401
    });
  });

  it("refuses a revoked credential without counting it against the throttle", async () => {
    const t = store("token", "pri_own_x", { revokedAt: new Date("2026-10-01T00:00:00Z") });
    for (let i = 0; i < 20; i += 1)
      expect(await verifyOwnerCredential(req({ "x-openrhen-owner": "pri_own_x" }), t.deps)).toMatchObject({
        kind: "invalid",
        status: 401,
        error: "The owner credential was revoked."
      });
  });

  it("refuses an expired session", async () => {
    const b = store("browser", "pri_ses_y", { expiresAt: new Date(NOW.getTime() - 1) });
    expect(await verifyOwnerCredential(req({ cookie: "openrhen_owner=pri_ses_y" }), b.deps)).toMatchObject({
      kind: "invalid",
      status: 401,
      error: "The owner credential has expired."
    });
  });

  it("throttles an address that keeps presenting unknown secrets", async () => {
    const t = store("token", "pri_own_x");
    let last = await verifyOwnerCredential(req({ "x-openrhen-owner": "guess-0" }), t.deps);
    for (let i = 1; i <= 10; i += 1)
      last = await verifyOwnerCredential(req({ "x-openrhen-owner": `guess-${i}` }), t.deps);
    expect(last).toMatchObject({ kind: "invalid", status: 429 });
    // even the right token waits out the window
    expect(await verifyOwnerCredential(req({ "x-openrhen-owner": "pri_own_x" }), t.deps)).toMatchObject({
      status: 429
    });
  });

  it("answers a stale cookie as unauthenticated, clears it, and never throttles it", async () => {
    vi.stubEnv("OWNER_RECOVERY_TOKEN", hash("recover"));
    const t = store("browser", "pri_ses_y");
    for (let i = 0; i < 12; i += 1)
      expect(await verifyOwnerCredential(req({ cookie: `openrhen_owner=stale-${i}` }), t.deps)).toMatchObject({
        kind: "invalid",
        status: 401,
        clearCookie: true
      });
    expect(await verifyEnrollSecret(req({}), "recover", t.deps)).toBe("ok");
    const revoked = store("browser", "pri_ses_r", { revokedAt: NOW });
    expect(await verifyOwnerCredential(req({ cookie: "openrhen_owner=pri_ses_r" }), revoked.deps)).toMatchObject({
      clearCookie: true
    });
    // a bad header is still a guess
    expect(await verifyOwnerCredential(req({ "x-openrhen-owner": "guess" }), t.deps)).not.toHaveProperty("clearCookie");
  });

  it("is a 503, not an open door, when the store cannot be read", async () => {
    const deps: OwnerDeps = {
      lookup: async () => {
        throw new Error("db down");
      },
      throttle: createFailureThrottle()
    };
    expect(await verifyOwnerCredential(req({ "x-openrhen-owner": "pri_own_x" }), deps)).toMatchObject({
      status: 503
    });
  });

  it("reports a slid session so the cookie is sent again", async () => {
    const b = store("browser", "pri_ses_slide");
    b.touch.mockResolvedValue(true);
    expect(await verifyOwnerCredential(req({ cookie: "openrhen_owner=pri_ses_slide" }), b.deps)).toMatchObject({
      kind: "ok",
      slid: true
    });
  });
});

describe("recovery token", () => {
  it("matches only the configured sha256, in either case, and never when unset", () => {
    expect(matchesRecovery("secret", undefined)).toBe(false);
    expect(matchesRecovery("secret", hash("secret"))).toBe(true);
    expect(matchesRecovery("other", hash("secret"))).toBe(false);
    vi.stubEnv("OWNER_RECOVERY_TOKEN", hash("secret").toUpperCase());
    expect(matchesRecovery("secret")).toBe(true);
    vi.stubEnv("OWNER_RECOVERY_TOKEN", "not-a-hash");
    expect(matchesRecovery("not-a-hash")).toBe(false);
  });

  it("verifyEnrollSecret takes the recovery token or a live owner token, and throttles guesses", async () => {
    const t = store("token", "pri_own_x");
    vi.stubEnv("OWNER_RECOVERY_TOKEN", hash("recover"));
    expect(await verifyEnrollSecret(req({}), "recover", t.deps)).toBe("ok");
    expect(await verifyEnrollSecret(req({}), "pri_own_x", t.deps)).toBe("ok");
    expect(await verifyEnrollSecret(req({}), "nope", t.deps)).toBe("bad");
    const revoked = store("token", "pri_own_r", { revokedAt: NOW });
    expect(await verifyEnrollSecret(req({}), "pri_own_r", revoked.deps)).toBe("bad");
    for (let i = 0; i < 10; i += 1) await verifyEnrollSecret(req({}), `g${i}`, t.deps);
    expect(await verifyEnrollSecret(req({}), "recover", t.deps)).toBe("throttled");
  });
});

describe("cookie and same-origin", () => {
  it("is HttpOnly and SameSite=Strict, Secure over https, 30 days, and cleared with Max-Age=0", () => {
    const http = ownerCookie(req({}), "pri_ses_y");
    expect(http).toContain("HttpOnly");
    expect(http).toContain("SameSite=Strict");
    expect(http).toContain(`Max-Age=${30 * 86_400}`);
    expect(http).not.toContain("Secure");
    expect(ownerCookie(req({ "x-forwarded-proto": "https" }), "pri_ses_y")).toContain("; Secure");
    expect(ownerCookie(req({}, "GET", "https://portal.test/"), "pri_ses_y")).toContain("; Secure");
    expect(ownerCookie(req({}), null)).toContain("Max-Age=0");
  });

  it("needs an Origin that is this host", () => {
    expect(sameOrigin(req({ host: "portal.test", origin: "http://portal.test" }, "POST"))).toBe(true);
    expect(sameOrigin(req({ host: "portal.test", origin: "http://evil.portal.test" }, "POST"))).toBe(false);
    expect(sameOrigin(req({ host: "portal.test", origin: "null" }, "POST"))).toBe(false);
    expect(sameOrigin(req({ host: "portal.test" }, "POST"))).toBe(false);
  });
});

const dbAgent: AgentPrincipal = {
  name: "companion",
  source: "db",
  tokenId: "t",
  scopes: ["read:mail"],
  directWrites: {}
};
const envAgent: AgentPrincipal = { name: "legacy", source: "env", scopes: [], directWrites: {} };

describe("ownerGate", () => {
  const gate = (request: Request, over: Partial<Parameters<typeof ownerGate>[0]> = {}) =>
    ownerGate({ request, route: "/api/commands/action", agent: undefined, mode: "require", ...over });

  it("does nothing when off", async () => {
    expect(await gate(req({}, "POST"), { mode: "off" })).toEqual({});
    vi.stubEnv("OPENRHEN_OWNER_AUTH", "bogus");
    expect(ownerAuthMode()).toBe("off");
  });

  it("require: refuses an anonymous write and a name-only write with a 401", async () => {
    const t = store("token", "pri_own_x");
    for (const headers of [{}, { "x-openrhen-agent": "companion" }]) {
      const out = await gate(req(headers, "POST"), { deps: t.deps });
      expect(out.refusal?.status).toBe(401);
    }
  });

  it("require: a revoked or unknown browser cookie is refused as expired, an absent one as anonymous", async () => {
    const b = store("browser", "pri_ses_y", { revokedAt: NOW });
    const stale = await gate(req({ cookie: "openrhen_owner=pri_ses_y", host: "portal.test" }, "GET"), {
      deps: b.deps,
      route: "/api/state"
    });
    expect(stale.refusal?.headers.get("x-owner-reason")).toBe("cookie-expired");
    expect(stale.clearCookie).toBe(true);
    const none = await gate(req({}, "GET"), { deps: b.deps, route: "/api/state" });
    expect(none.refusal?.headers.get("x-owner-reason")).toBe("read-anonymous");
  });

  it("require: an owner token passes and makes the caller the owner", async () => {
    const t = store("token", "pri_own_x");
    const out = await gate(req({ "x-openrhen-owner": "pri_own_x", "x-openrhen-agent": "companion" }, "POST"), {
      deps: t.deps
    });
    expect(out.refusal).toBeUndefined();
    expect(out.owner).toMatchObject({ credential: "token", via: "header" });
  });

  it("require: a cookie write needs a same-origin Origin; a cookie read does not", async () => {
    const b = store("browser", "pri_ses_y");
    const cookie = { cookie: "openrhen_owner=pri_ses_y", host: "portal.test" };
    expect((await gate(req(cookie, "POST"), { deps: b.deps })).refusal?.status).toBe(403);
    expect(
      (await gate(req({ ...cookie, origin: "http://portal.test" }, "POST"), { deps: b.deps })).refusal
    ).toBeUndefined();
    expect((await gate(req(cookie, "GET"), { deps: b.deps })).refusal).toBeUndefined();
  });

  it("require: an anonymous read of the API is refused, except a public route", async () => {
    const t = store("token", "pri_own_x");
    expect((await gate(req({}, "GET"), { deps: t.deps, route: "/api/mail" })).refusal?.status).toBe(401);
    expect((await gate(req({}, "GET"), { deps: t.deps, route: "/api/health/database" })).refusal).toBeUndefined();
  });

  it("require: a database agent is left to the scope check, and its owner header counts for nothing", async () => {
    const t = store("token", "pri_own_x");
    const out = await gate(req({ "x-openrhen-owner": "pri_own_x" }, "POST"), { agent: dbAgent, deps: t.deps });
    expect(out).toEqual({});
    expect(t.lookup).not.toHaveBeenCalled();
  });

  it("require: an environment-token agent is 403 on an owner-only route", async () => {
    const out = await gate(req({}, "POST"), { agent: envAgent, route: "/api/agent-tokens" });
    expect(out.refusal?.status).toBe(403);
  });

  it("require: a revoked credential is a 401 and a throttled address is a 429", async () => {
    const t = store("token", "pri_own_x", { revokedAt: NOW });
    expect((await gate(req({ "x-openrhen-owner": "pri_own_x" }, "POST"), { deps: t.deps })).refusal?.status).toBe(401);
    const hot = { ...t.deps, throttle: { retryAfter: () => 30, fail: () => {} } };
    const out = await gate(req({ "x-openrhen-owner": "pri_own_x" }, "POST"), { deps: hot });
    expect(out.refusal?.status).toBe(429);
    expect(out.refusal?.headers.get("retry-after")).toBe("30");
  });

  it("require: a stale cookie is a 401 that clears the cookie, and an exempt route still passes with it", async () => {
    const t = store("browser", "pri_ses_y");
    const stale = { cookie: "openrhen_owner=gone" };
    const out = await gate(req(stale, "POST"), { deps: t.deps });
    expect(out.refusal?.status).toBe(401);
    expect(out.clearCookie).toBe(true);
    expect(await gate(req(stale, "POST"), { route: "/api/owner/enroll", deps: t.deps })).toEqual({ clearCookie: true });
  });

  it("an exempt route needs no credential", async () => {
    expect((await gate(req({}, "POST"), { route: "/api/location/ping" })).refusal).toBeUndefined();
  });

  it("shadow: reports what require would refuse and refuses nothing", async () => {
    const t = store("token", "pri_own_x");
    const out = await gate(req({}, "POST"), { mode: "shadow", deps: t.deps });
    expect(out.refusal).toBeUndefined();
    expect(out.wouldRefuse).toMatchObject({ status: 401, reason: "write-anonymous" });
    // a credential that would pass changes nothing in shadow: the caller is treated exactly as under off
    expect(await gate(req({ "x-openrhen-owner": "pri_own_x" }, "POST"), { mode: "shadow", deps: t.deps })).toEqual({});
  });
});

describe("worker token", () => {
  const WORKER = "worker-secret-1";
  const route = "/api/connections/[connectionId]/sync";
  const gate = (request: Request, over: Partial<Parameters<typeof ownerGate>[0]> = {}) =>
    ownerGate({ request, route, agent: undefined, mode: "require", ...over });

  it("matchesWorker compares in constant time and is false when none is configured", () => {
    expect(matchesWorker(WORKER, hash(WORKER))).toBe(true);
    expect(matchesWorker("other", hash(WORKER))).toBe(false);
    expect(matchesWorker(WORKER, undefined)).toBe(false);
    vi.stubEnv("WORKER_TOKEN_HASH", "not-hex");
    expect(matchesWorker(WORKER)).toBe(false);
    vi.stubEnv("WORKER_TOKEN_HASH", hash(WORKER));
    expect(matchesWorker(WORKER)).toBe(true);
  });

  it("require: a worker route refuses anonymous callers and accepts the worker token or an owner credential", async () => {
    vi.stubEnv("WORKER_TOKEN_HASH", hash(WORKER));
    const t = store("token", "pri_own_x");
    for (const method of ["GET", "POST"]) {
      const anonymous = await gate(req({}, method), { deps: t.deps });
      expect(anonymous.refusal?.status).toBe(401);
      expect(anonymous.refusal?.headers.get("x-owner-reason")).toBe("worker-anonymous");
      expect(await gate(req({ "x-openrhen-worker": WORKER }, method), { deps: t.deps })).toEqual({});
      expect((await gate(req({ "x-openrhen-owner": "pri_own_x" }, method), { deps: t.deps })).owner).toBeDefined();
    }
    expect(t.lookup).toHaveBeenCalledTimes(2);
  });

  it("require: a wrong worker token is a 401 that counts against the shared throttle, and a throttled address a 429", async () => {
    vi.stubEnv("WORKER_TOKEN_HASH", hash(WORKER));
    const t = store("token", "pri_own_x");
    const fail = vi.fn();
    const deps = { ...t.deps, throttle: { retryAfter: () => 0, fail } };
    expect((await gate(req({ "x-openrhen-worker": "nope" }, "POST"), { deps })).refusal?.status).toBe(401);
    expect(fail).toHaveBeenCalledTimes(1);
    const hot = { ...t.deps, throttle: { retryAfter: () => 30, fail } };
    const out = await gate(req({ "x-openrhen-worker": WORKER }, "POST"), { deps: hot });
    expect(out.refusal?.status).toBe(429);
    expect(out.refusal?.headers.get("retry-after")).toBe("30");
  });

  it("require: with no WORKER_TOKEN_HASH configured, no worker token is accepted", async () => {
    vi.stubEnv("WORKER_TOKEN_HASH", "");
    expect(
      (await gate(req({ "x-openrhen-worker": WORKER }, "POST"), { deps: store("token", "a").deps })).refusal?.status
    ).toBe(401);
  });

  it("require: the worker token is refused on owner-only and agent routes", async () => {
    vi.stubEnv("WORKER_TOKEN_HASH", hash(WORKER));
    const t = store("token", "pri_own_x");
    for (const other of [
      "/api/commands/action",
      "/api/agent-tokens",
      "/api/connections/example_shared/write-proof",
      "/api/state"
    ])
      for (const method of ["GET", "POST"]) {
        const out = await gate(req({ "x-openrhen-worker": WORKER }, method), { route: other, deps: t.deps });
        expect(out.refusal?.status, `${method} ${other}`).toBe(401);
      }
  });

  it("shadow: a worker route reports what require would refuse and refuses nothing; off changes nothing", async () => {
    const t = store("token", "pri_own_x");
    const out = await gate(req({}, "POST"), { mode: "shadow", deps: t.deps });
    expect(out.refusal).toBeUndefined();
    expect(out.wouldRefuse).toEqual({ status: 401, reason: "worker-anonymous", worker: true });
    expect(await gate(req({}, "POST"), { mode: "off" })).toEqual({});
  });
});

describe("device token", () => {
  const DEVICE = "device-secret-1";
  const gate = (route: string, request: Request, over: Partial<Parameters<typeof ownerGate>[0]> = {}) =>
    ownerGate({ request, route, agent: undefined, mode: "require", ...over });

  it("matchesDevice compares in constant time and is false when none is configured", () => {
    expect(matchesDevice(DEVICE, hash(DEVICE))).toBe(true);
    expect(matchesDevice("other", hash(DEVICE))).toBe(false);
    expect(matchesDevice(DEVICE, undefined)).toBe(false);
    vi.stubEnv("DEVICE_TOKEN_HASH", "not-hex");
    expect(matchesDevice(DEVICE)).toBe(false);
  });

  it("require: the two device routes refuse anonymous callers and accept the device token or an owner credential", async () => {
    vi.stubEnv("DEVICE_TOKEN_HASH", hash(DEVICE));
    const t = store("token", "pri_own_x");
    for (const [method, route] of [
      ["GET", "/api/device/now"],
      ["POST", "/api/device/action"]
    ] as const) {
      const anonymous = await gate(route, req({}, method), { deps: t.deps });
      expect(anonymous.refusal?.status).toBe(401);
      expect(anonymous.refusal?.headers.get("x-owner-reason")).toBe("device-anonymous");
      expect(await gate(route, req({ "x-openrhen-device": DEVICE }, method), { deps: t.deps })).toEqual({
        device: true
      });
      expect(
        (await gate(route, req({ "x-openrhen-owner": "pri_own_x" }, method), { deps: t.deps })).owner
      ).toBeDefined();
    }
  });

  it("require: a wrong device token is a 401 counted by the shared throttle, a throttled address a 429", async () => {
    vi.stubEnv("DEVICE_TOKEN_HASH", hash(DEVICE));
    const fail = vi.fn();
    const deps = { ...store("token", "a").deps, throttle: { retryAfter: () => 0, fail } };
    expect((await gate("/api/device/now", req({ "x-openrhen-device": "nope" }, "GET"), { deps })).refusal?.status).toBe(
      401
    );
    expect(fail).toHaveBeenCalledTimes(1);
    const hot = { ...deps, throttle: { retryAfter: () => 30, fail } };
    expect(
      (await gate("/api/device/now", req({ "x-openrhen-device": DEVICE }, "GET"), { deps: hot })).refusal?.status
    ).toBe(429);
  });

  it("require: with no DEVICE_TOKEN_HASH configured, no device token is accepted", async () => {
    vi.stubEnv("DEVICE_TOKEN_HASH", "");
    const out = await gate("/api/device/now", req({ "x-openrhen-device": DEVICE }, "GET"), {
      deps: store("token", "a").deps
    });
    expect(out.refusal?.status).toBe(401);
  });

  it("require: the device token opens nothing but the device routes, and the worker token does not open them", async () => {
    vi.stubEnv("DEVICE_TOKEN_HASH", hash(DEVICE));
    vi.stubEnv("WORKER_TOKEN_HASH", hash("w"));
    const t = store("token", "pri_own_x");
    for (const other of [
      "/api/state",
      "/api/commands/action",
      "/api/agent-tokens",
      "/api/connections/[connectionId]/sync",
      "/api/check-ins/current"
    ])
      for (const method of ["GET", "POST"]) {
        const out = await gate(other, req({ "x-openrhen-device": DEVICE }, method), { deps: t.deps });
        expect(out.refusal?.status, `${method} ${other}`).toBe(401);
      }
    for (const [method, route] of [
      ["GET", "/api/device/now"],
      ["POST", "/api/device/action"]
    ] as const)
      expect((await gate(route, req({ "x-openrhen-worker": "w" }, method), { deps: t.deps })).refusal?.status).toBe(
        401
      );
  });

  describe("onDeviceRefused", () => {
    const refused = (spy: (reason: "device-invalid" | "device-anonymous") => void, over: Partial<OwnerDeps> = {}) => ({
      ...store("token", "a").deps,
      onDeviceRefused: spy,
      ...over
    });

    it("hears device-invalid for a wrong token and device-anonymous for no credential", async () => {
      vi.stubEnv("DEVICE_TOKEN_HASH", hash(DEVICE));
      const spy = vi.fn();
      await gate("/api/device/now", req({ "x-openrhen-device": "nope" }, "GET"), { deps: refused(spy) });
      await gate("/api/device/now", req({}, "GET"), { deps: refused(spy) });
      expect(spy.mock.calls).toEqual([["device-invalid"], ["device-anonymous"]]);
    });

    it("stays quiet for an accepted token, an owner credential, a throttled address, shadow mode and other routes", async () => {
      vi.stubEnv("DEVICE_TOKEN_HASH", hash(DEVICE));
      const spy = vi.fn();
      await gate("/api/device/now", req({ "x-openrhen-device": DEVICE }, "GET"), { deps: refused(spy) });
      await gate("/api/device/now", req({ "x-openrhen-owner": "a" }, "GET"), { deps: refused(spy) });
      const hot = refused(spy, { throttle: { retryAfter: () => 30, fail: vi.fn() } });
      await gate("/api/device/now", req({ "x-openrhen-device": "nope" }, "GET"), { deps: hot });
      await gate("/api/device/now", req({}, "GET"), { mode: "shadow", deps: refused(spy) });
      await gate("/api/state", req({}, "GET"), { deps: refused(spy) });
      expect(spy).not.toHaveBeenCalled();
    });

    it("never lets a failing hook change the refusal", async () => {
      vi.stubEnv("DEVICE_TOKEN_HASH", hash(DEVICE));
      const out = await gate("/api/device/now", req({}, "GET"), {
        deps: refused(
          vi.fn(() => {
            throw new Error("hook broke");
          })
        )
      });
      expect(out.refusal?.status).toBe(401);
    });
  });

  it("shadow reports what require would refuse as a device refusal; off changes nothing", async () => {
    const t = store("token", "pri_own_x");
    const out = await gate("/api/device/now", req({}, "GET"), { mode: "shadow", deps: t.deps });
    expect(out.refusal).toBeUndefined();
    expect(out.wouldRefuse).toEqual({ status: 401, reason: "device-anonymous", device: true });
    expect(await gate("/api/device/now", req({}, "GET"), { mode: "off" })).toEqual({});
  });
});
