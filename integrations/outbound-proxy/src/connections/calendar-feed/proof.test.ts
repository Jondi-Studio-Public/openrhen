import { EventEmitter } from "node:events";
import type tls from "node:tls";
import { describe, expect, it, vi } from "vitest";
import { FeedFetchError } from "./fetch.js";
import { proveCalendarFeed } from "./proof.js";

const URL_WITH_SECRET = "https://calendar.example.com/private/SECRETPATH123/feed.ics?token=SECRETTOKEN456";

type Plan = "secure" | { error: string; code?: string } | "hang";

/** A fake `tls.connect`: one entry of `plans` per attempt, in order. */
function fakeConnect(plans: Plan[]) {
  const calls: Array<Record<string, unknown>> = [];
  const sockets: Array<EventEmitter & { destroy: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> }> = [];
  const connect = ((options: Record<string, unknown>) => {
    calls.push(options);
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn(), write: vi.fn(), end: vi.fn() });
    sockets.push(socket);
    const plan = plans[calls.length - 1] ?? "hang";
    queueMicrotask(() => {
      if (plan === "secure") socket.emit("secureConnect");
      else if (plan !== "hang") socket.emit("error", Object.assign(new Error(plan.error), { code: plan.code }));
    });
    return socket;
  }) as unknown as typeof tls.connect;
  return { connect, calls, sockets };
}

const answer = (...addresses: Array<[string, number]>) =>
  vi.fn(async () => addresses.map(([address, family]) => ({ address, family })));

describe("proveCalendarFeed", () => {
  it("resolves, checks and handshakes against the hostname, then drops the socket without sending anything", async () => {
    const { connect, calls, sockets } = fakeConnect(["secure"]);
    const lookup = answer(["93.184.216.34", 4]);
    await expect(proveCalendarFeed(URL_WITH_SECRET, { lookup, connect })).resolves.toEqual({
      host: "calendar.example.com"
    });
    expect(lookup).toHaveBeenCalledWith("calendar.example.com");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      host: "93.184.216.34",
      port: 443,
      servername: "calendar.example.com",
      rejectUnauthorized: true
    });
    expect(sockets[0]!.write).not.toHaveBeenCalled();
    expect(sockets[0]!.destroy).toHaveBeenCalled();
  });

  it("maps webcal to https and refuses http, userinfo, IP literals and other ports before any DNS", async () => {
    const lookup = answer(["93.184.216.34", 4]);
    const { connect } = fakeConnect(["secure"]);
    await expect(proveCalendarFeed("webcal://calendar.example.com/a.ics", { lookup, connect })).resolves.toBeTruthy();
    for (const bad of [
      "http://calendar.example.com/a.ics",
      "https://user:pw@calendar.example.com/a.ics",
      "https://93.184.216.34/a.ics",
      "https://calendar.example.com:8443/a.ics",
      "not a url"
    ]) {
      lookup.mockClear();
      await expect(proveCalendarFeed(bad, { lookup, connect })).rejects.toMatchObject({ code: "bad_url" });
      expect(lookup).not.toHaveBeenCalled();
    }
  });

  it("rejects when any DNS answer is denied, and never connects", async () => {
    const { connect, calls } = fakeConnect(["secure"]);
    const lookup = answer(["93.184.216.34", 4], ["10.0.0.5", 4]);
    await expect(proveCalendarFeed(URL_WITH_SECRET, { lookup, connect })).rejects.toMatchObject({
      code: "denied_address",
      host: "calendar.example.com"
    });
    expect(calls).toHaveLength(0);
  });

  it("fails DNS cleanly on an empty answer or a lookup error", async () => {
    const { connect } = fakeConnect([]);
    await expect(proveCalendarFeed(URL_WITH_SECRET, { lookup: answer(), connect })).rejects.toMatchObject({
      code: "dns_failed"
    });
    const failing = vi.fn(async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND calendar.example.com"), { code: "ENOTFOUND" });
    });
    await expect(proveCalendarFeed(URL_WITH_SECRET, { lookup: failing, connect })).rejects.toMatchObject({
      code: "dns_failed",
      host: "calendar.example.com"
    });
  });

  it("tries IPv4 first and moves on only after a connect-level failure", async () => {
    const { connect, calls } = fakeConnect([{ error: "refused", code: "ECONNREFUSED" }, "secure"]);
    const lookup = answer(["2606:4700::1", 6], ["93.184.216.34", 4], ["93.184.216.35", 4]);
    await proveCalendarFeed(URL_WITH_SECRET, { lookup, connect });
    expect(calls.map((c) => c.host)).toEqual(["93.184.216.34", "93.184.216.35"]);
  });

  it("does not retry a TLS error", async () => {
    const { connect, calls } = fakeConnect([{ error: "certificate has expired", code: "CERT_HAS_EXPIRED" }, "secure"]);
    const lookup = answer(["93.184.216.34", 4], ["93.184.216.35", 4]);
    await expect(proveCalendarFeed(URL_WITH_SECRET, { lookup, connect })).rejects.toMatchObject({ code: "network" });
    expect(calls).toHaveLength(1);
  });

  it("gives up with connect_failed when every address refuses", async () => {
    const refused = { error: "refused", code: "ECONNREFUSED" };
    const { connect, calls } = fakeConnect([refused, refused]);
    const lookup = answer(["93.184.216.34", 4], ["2606:4700::1", 6]);
    await expect(proveCalendarFeed(URL_WITH_SECRET, { lookup, connect })).rejects.toMatchObject({
      code: "connect_failed"
    });
    expect(calls).toHaveLength(2);
  });

  it("treats a handshake that never completes as a connect-level failure within the connect budget", async () => {
    const { connect } = fakeConnect(["hang"]);
    const lookup = answer(["93.184.216.34", 4]);
    await expect(proveCalendarFeed(URL_WITH_SECRET, { lookup, connect, connectMs: 20 })).rejects.toMatchObject({
      code: "connect_failed"
    });
  });

  it("stops at once when the caller aborts", async () => {
    const { connect } = fakeConnect(["hang"]);
    const controller = new AbortController();
    const pending = proveCalendarFeed(URL_WITH_SECRET, {
      lookup: answer(["93.184.216.34", 4]),
      connect,
      signal: controller.signal
    });
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });

  it("never puts the URL in an error", async () => {
    const { connect } = fakeConnect([{ error: `boom ${URL_WITH_SECRET}`, code: "EPROTO" }]);
    const error = await proveCalendarFeed(URL_WITH_SECRET, { lookup: answer(["93.184.216.34", 4]), connect }).catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(FeedFetchError);
    const text = String((error as Error).message) + JSON.stringify(error);
    expect(text).not.toMatch(/SECRETPATH123|SECRETTOKEN456/);
  });
});
