import { EventEmitter } from "node:events";
import https from "node:https";
import { PassThrough } from "node:stream";
import zlib from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { decodeBody, toUtf8Bytes } from "./decode.js";
import { FeedFetchError, fetchCalendarFeed, normalizeFeedUrl } from "./fetch.js";
import { isDeniedAddress } from "./guard.js";

const ICS = "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n";

describe("address deny table", () => {
  const denied = [
    "0.1.2.3",
    "10.0.0.1",
    "100.64.1.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::7f00:1",
    "64:ff9b::a00:1",
    "64:ff9b:1::1",
    "100::1",
    "2001::1",
    "2001:1::1",
    "2001:db8::1",
    "2002::1",
    "3fff::1",
    "5f00::1",
    "fc00::1",
    "fd12::1",
    "fe80::1",
    "fec0::1",
    "feff::1",
    "ff02::1",
    "not-an-ip",
    ""
  ];
  const allowed = [
    "93.184.216.34",
    "8.8.8.8",
    "172.32.0.1",
    "100.63.0.1",
    "198.20.0.1",
    "2606:4700::1111",
    "2a00:1450:4009::200e",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808"
  ];
  it.each(denied)("denies %s", (a) => expect(isDeniedAddress(a)).toBe(true));
  it.each(allowed)("allows %s", (a) => expect(isDeniedAddress(a)).toBe(false));
});

describe("url rules", () => {
  it("maps webcal(s) to https", () => {
    expect(normalizeFeedUrl("webcal://example.com/a.ics").protocol).toBe("https:");
    expect(normalizeFeedUrl("WEBCALS://example.com/a.ics").protocol).toBe("https:");
  });
  it.each([
    "http://example.com/a.ics",
    "https://u:p@example.com/a",
    "https://example.com:8443/a",
    "https://1.2.3.4/a",
    "https://[::1]/a",
    "ftp://example.com/a",
    "nonsense"
  ])("refuses %s", (u) => expect(() => normalizeFeedUrl(u)).toThrow(FeedFetchError));
  it("accepts an explicit 443", () =>
    expect(normalizeFeedUrl("https://example.com:443/a").hostname).toBe("example.com"));
});

describe("decoding", () => {
  const body = Buffer.from(ICS);
  it("gzip, x-gzip, deflate (zlib and raw), br and stacked codings", async () => {
    expect(await decodeBody(zlib.gzipSync(body), "gzip", 1000)).toEqual(body);
    expect(await decodeBody(zlib.gzipSync(body), "X-Gzip", 1000)).toEqual(body);
    expect(await decodeBody(zlib.deflateSync(body), "deflate", 1000)).toEqual(body);
    expect(await decodeBody(zlib.deflateRawSync(body), "deflate", 1000)).toEqual(body);
    expect(await decodeBody(zlib.brotliCompressSync(body), "br", 1000)).toEqual(body);
    expect(await decodeBody(zlib.brotliCompressSync(zlib.gzipSync(body)), "gzip, br", 1000)).toEqual(body);
    expect(await decodeBody(body, "identity", 1000)).toEqual(body);
  });
  it("handles concatenated gzip members and a gzip body with no header", async () => {
    const two = Buffer.concat([zlib.gzipSync("BEGIN:VCALENDAR\r\n"), zlib.gzipSync("END:VCALENDAR\r\n")]);
    expect((await decodeBody(two, "gzip", 1000)).toString()).toBe(ICS);
    expect(await decodeBody(zlib.gzipSync(body), undefined, 1000)).toEqual(body);
  });
  // Building a 50 MB brotli stream at the default quality takes seconds, which timed out under CI load; the
  // test needs a bomb, not a small one, so compress cheaply and give the whole case room.
  const cheapBrotli = (input: Buffer) =>
    zlib.brotliCompressSync(input, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 1 } });
  it("rejects a decompression bomb at the cap", { timeout: 60_000 }, async () => {
    const bomb = zlib.gzipSync(Buffer.alloc(50 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(100_000);
    await expect(decodeBody(bomb, "gzip", 5 * 1024 * 1024)).rejects.toMatchObject({ code: "too_large" });
    await expect(decodeBody(cheapBrotli(Buffer.alloc(50 * 1024 * 1024)), "br", 5 * 1024 * 1024)).rejects.toMatchObject({
      code: "too_large"
    });
    await expect(
      decodeBody(zlib.deflateSync(Buffer.alloc(50 * 1024 * 1024)), "deflate", 5 * 1024 * 1024)
    ).rejects.toMatchObject({ code: "too_large" });
  });
  it("rejects a nested gzip bomb and unknown or corrupt codings", async () => {
    let layered: Buffer = Buffer.alloc(20 * 1024 * 1024);
    for (let i = 0; i < 3; i++) layered = zlib.gzipSync(layered);
    await expect(decodeBody(layered, undefined, 5 * 1024 * 1024)).rejects.toMatchObject({ code: "too_large" });
    for (let i = 0; i < 3; i++) layered = zlib.gzipSync(layered);
    await expect(decodeBody(layered, undefined, 5 * 1024 * 1024)).rejects.toMatchObject({ code: "decode_failed" });
    await expect(decodeBody(body, "compress", 1000)).rejects.toMatchObject({ code: "unsupported_encoding" });
    await expect(decodeBody(body, "gzip", 1000)).rejects.toMatchObject({ code: "decode_failed" });
    await expect(decodeBody(body, "gzip, gzip, gzip, gzip", 1000)).rejects.toMatchObject({
      code: "unsupported_encoding"
    });
  });
  it("normalises BOMs and charsets to UTF-8", () => {
    expect(toUtf8Bytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(ICS)]), undefined).toString()).toBe(
      ICS
    );
    expect(
      toUtf8Bytes(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(ICS, "utf16le")]), "text/calendar").toString()
    ).toBe(ICS);
    const be = Buffer.from(ICS, "utf16le").swap16();
    expect(toUtf8Bytes(Buffer.concat([Buffer.from([0xfe, 0xff]), be]), undefined).toString()).toBe(ICS);
    expect(toUtf8Bytes(Buffer.from([0x43, 0x61, 0x66, 0xe9]), "text/calendar; charset=ISO-8859-1").toString()).toBe(
      "Café"
    );
    expect(toUtf8Bytes(Buffer.from("Café"), 'text/calendar; charset="utf-8"').toString()).toBe("Café");
    expect(toUtf8Bytes(Buffer.from("Café"), "text/calendar; charset=klingon").toString()).toBe("Café");
    expect(toUtf8Bytes(Buffer.from(ICS), "application/octet-stream").toString()).toBe(ICS);
  });
});

type Plan = {
  code?: string;
  status?: number;
  headers?: Record<string, string>;
  body?: Buffer | (() => Buffer);
  connecting?: boolean;
  endless?: boolean;
};
function fakeTransport(plans: Plan[]) {
  const calls: https.RequestOptions[] = [];
  const responses: PassThrough[] = [];
  const request = ((opts: https.RequestOptions) => {
    const plan = plans[calls.length] ?? { code: "ECONNREFUSED" };
    calls.push(opts);
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: (e?: Error) => void };
    req.destroy = (e) => {
      if (e) setImmediate(() => req.emit("error", e));
    };
    req.end = () =>
      setImmediate(() => {
        const socket = Object.assign(new EventEmitter(), { connecting: plan.connecting ?? false });
        req.emit("socket", socket);
        if (plan.code) return req.emit("error", Object.assign(new Error(plan.code), { code: plan.code }));
        if (plan.connecting) return;
        const res = Object.assign(new PassThrough(), { statusCode: plan.status ?? 200, headers: plan.headers ?? {} });
        responses.push(res);
        req.emit("response", res);
        if (plan.endless) return;
        res.end(typeof plan.body === "function" ? plan.body() : (plan.body ?? Buffer.from(ICS)));
      });
    return req;
  }) as unknown as typeof https.request;
  return { request, calls, responses };
}
const pub =
  (...a: [string, number][]) =>
  async () =>
    a.map(([address, family]) => ({ address, family }));
const base = { lookup: pub(["93.184.216.34", 4]) };

describe("fetchCalendarFeed", () => {
  it("connects to the checked IP with servername and Host, advertises encodings, uses a private agent", async () => {
    process.env.HTTPS_PROXY = "http://127.0.0.1:9";
    const t = fakeTransport([
      { headers: { "content-encoding": "gzip", "content-type": "text/calendar" }, body: zlib.gzipSync(ICS) }
    ]);
    const r = await fetchCalendarFeed("webcal://cal.example.com/secret/token.ics?k=1", { ...base, request: t.request });
    delete process.env.HTTPS_PROXY;
    expect(r.bytes.toString()).toBe(ICS);
    const o = t.calls[0]!;
    expect(o).toMatchObject({
      host: "93.184.216.34",
      servername: "cal.example.com",
      port: 443,
      path: "/secret/token.ics?k=1"
    });
    expect((o.headers as Record<string, string>).host).toBe("cal.example.com");
    expect((o.headers as Record<string, string>)["accept-encoding"]).toBe("gzip, deflate, br");
    expect(o.agent).toBeInstanceOf(https.Agent);
    expect(o.agent).not.toBe(https.globalAgent);
    expect(Object.keys(o.headers as object)).not.toContain("cookie");
  });
  it("rejects if any DNS answer is denied", async () => {
    const t = fakeTransport([]);
    await expect(
      fetchCalendarFeed("https://x.example.com/a", {
        lookup: pub(["93.184.216.34", 4], ["fec0::1", 6]),
        request: t.request
      })
    ).rejects.toMatchObject({ code: "denied_address" });
    expect(t.calls).toHaveLength(0);
  });
  it("falls back to the next address after connect failures, IPv4 first, and not after TLS errors", async () => {
    const t = fakeTransport([{ code: "ENETUNREACH" }, {}]);
    await fetchCalendarFeed("https://x.example.com/a", {
      lookup: pub(["2606:4700::1111", 6], ["93.184.216.34", 4], ["2606:4700::1112", 6]),
      request: t.request
    });
    expect(t.calls.map((c) => c.host)).toEqual(["93.184.216.34", "2606:4700::1111"]);
    const tls = fakeTransport([{ code: "CERT_HAS_EXPIRED" }, {}]);
    await expect(
      fetchCalendarFeed("https://x.example.com/a", {
        lookup: pub(["93.184.216.34", 4], ["8.8.8.8", 4]),
        request: tls.request
      })
    ).rejects.toMatchObject({ code: "network" });
    expect(tls.calls).toHaveLength(1);
  });
  it("fails when every address refuses, and when the shared connect budget is spent", async () => {
    const t = fakeTransport([{ code: "ECONNREFUSED" }, { code: "ECONNREFUSED" }]);
    await expect(
      fetchCalendarFeed("https://x.example.com/a", { lookup: pub(["8.8.8.8", 4], ["8.8.4.4", 4]), request: t.request })
    ).rejects.toMatchObject({ code: "connect_failed" });
    const slow = fakeTransport([{ connecting: true }, {}]);
    await expect(
      fetchCalendarFeed("https://x.example.com/a", {
        lookup: pub(["8.8.8.8", 4], ["8.8.4.4", 4]),
        request: slow.request,
        connectMs: 30
      })
    ).rejects.toMatchObject({ code: "connect_failed" });
    expect(slow.calls).toHaveLength(1);
  });
  it("treats a connect timeout as the spent budget even when the wall clock has not caught up with the timer", async () => {
    // setTimeout runs off libuv's cached loop clock, Date.now() off the wall clock. On a busy host the timer
    // can fire while Date.now() still reads before the deadline; freezing Date.now() reproduces that exactly.
    const frozen = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(frozen);
    try {
      const slow = fakeTransport([{ connecting: true }, {}]);
      await expect(
        fetchCalendarFeed("https://x.example.com/a", {
          lookup: pub(["8.8.8.8", 4], ["8.8.4.4", 4]),
          request: slow.request,
          connectMs: 30
        })
      ).rejects.toMatchObject({ code: "connect_failed" });
      expect(slow.calls).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });
  it("follows up to 3 redirects, rechecking each hop", async () => {
    const ok = fakeTransport([
      { status: 302, headers: { location: "/b" } },
      { status: 301, headers: { location: "https://other.example.com/c" } },
      { status: 307, headers: { location: "/d" } },
      {}
    ]);
    await expect(fetchCalendarFeed("https://x.example.com/a", { ...base, request: ok.request })).resolves.toMatchObject(
      { host: "other.example.com" }
    );
    const many = fakeTransport(Array.from({ length: 5 }, () => ({ status: 302, headers: { location: "/n" } })));
    await expect(
      fetchCalendarFeed("https://x.example.com/a", { ...base, request: many.request })
    ).rejects.toMatchObject({ code: "too_many_redirects" });
  });
  it.each([
    "http://x.example.com/a",
    "https://x.example.com:8443/a",
    "https://u:p@x.example.com/a",
    "https://169.254.169.254/latest",
    "https://[::1]/a",
    "ftp://x.example.com/a"
  ])("refuses a redirect to %s", async (location) => {
    const t = fakeTransport([{ status: 302, headers: { location } }]);
    await expect(fetchCalendarFeed("https://x.example.com/a", { ...base, request: t.request })).rejects.toMatchObject({
      code: "bad_redirect"
    });
    expect(t.calls).toHaveLength(1);
  });
  it("refuses a redirect to a host that resolves into a denied range (rebinding)", async () => {
    const t = fakeTransport([{ status: 302, headers: { location: "https://evil.example.com/" } }]);
    const lookup = async (h: string) => [
      { address: h === "evil.example.com" ? "10.0.0.5" : "93.184.216.34", family: 4 }
    ];
    await expect(fetchCalendarFeed("https://x.example.com/a", { lookup, request: t.request })).rejects.toMatchObject({
      code: "denied_address",
      host: "evil.example.com"
    });
    expect(t.calls).toHaveLength(1);
  });
  it("refuses non-200, oversized (raw and decoded) and missing Location", async () => {
    await expect(
      fetchCalendarFeed("https://x.example.com/a", { ...base, request: fakeTransport([{ status: 404 }]).request })
    ).rejects.toMatchObject({ code: "http_status", status: 404 });
    await expect(
      fetchCalendarFeed("https://x.example.com/a", {
        ...base,
        maxBytes: 100,
        request: fakeTransport([{ body: Buffer.alloc(500, 65) }]).request
      })
    ).rejects.toMatchObject({ code: "too_large" });
    await expect(
      fetchCalendarFeed("https://x.example.com/a", {
        ...base,
        maxBytes: 1000,
        request: fakeTransport([
          { headers: { "content-encoding": "gzip" }, body: zlib.gzipSync(Buffer.alloc(100_000)) }
        ]).request
      })
    ).rejects.toMatchObject({ code: "too_large" });
    await expect(
      fetchCalendarFeed("https://x.example.com/a", { ...base, request: fakeTransport([{ status: 302 }]).request })
    ).rejects.toMatchObject({ code: "bad_redirect" });
  });
  it("never puts the path or query in an error message", async () => {
    const url = "https://x.example.com/SECRETPATH?token=SECRETQ";
    for (const plan of [
      { status: 500 },
      { code: "ECONNREFUSED" },
      { code: "CERT_HAS_EXPIRED" },
      { status: 302, headers: { location: "http://x.example.com/SECRETPATH" } }
    ]) {
      const err = await fetchCalendarFeed(url, { ...base, request: fakeTransport([plan]).request }).catch(
        (e) => e as Error
      );
      expect(String(err) + JSON.stringify(err)).not.toMatch(/SECRET/);
    }
    const bad = await fetchCalendarFeed("http://x.example.com/SECRETPATH", base).catch((e) => e as Error);
    expect(String(bad)).not.toMatch(/SECRET/);
  });
  it("destroys the connection when it gives up on a redirect or error response", async () => {
    for (const plan of [
      { status: 500 },
      { status: 302 },
      { status: 302, headers: { location: "http://x.example.com/" } }
    ]) {
      const t = fakeTransport([{ ...plan, endless: true }]);
      await fetchCalendarFeed("https://x.example.com/a", { ...base, request: t.request }).catch(() => undefined);
      expect(t.responses[0]!.destroyed).toBe(true);
    }
  });
  it("accepts EADDRNOTAVAIL as a connect-level failure", async () => {
    const t = fakeTransport([{ code: "EADDRNOTAVAIL" }, {}]);
    await fetchCalendarFeed("https://x.example.com/a", {
      lookup: pub(["2606:4700::1111", 6], ["8.8.8.8", 4]),
      request: t.request
    });
    expect(t.calls).toHaveLength(2);
  });
  it("denies SIIT-translated IPv4", () => {
    expect(isDeniedAddress("::ffff:0:7f00:1")).toBe(true);
    expect(isDeniedAddress("::ffff:0:127.0.0.1")).toBe(true);
    expect(isDeniedAddress("::ffff:0:808:808")).toBe(false);
  });
  it("honours a signal that was already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      fetchCalendarFeed("https://x.example.com/a", { lookup: () => new Promise(() => {}), signal: ac.signal })
    ).rejects.toMatchObject({ code: "aborted" });
  });
  it("honours the caller's abort signal and the total deadline", async () => {
    const ac = new AbortController();
    const p = fetchCalendarFeed("https://x.example.com/a", { lookup: () => new Promise(() => {}), signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: "aborted" });
    await expect(
      fetchCalendarFeed("https://x.example.com/a", { lookup: () => new Promise(() => {}), totalMs: 20 })
    ).rejects.toMatchObject({ code: "timeout" });
  });
});
