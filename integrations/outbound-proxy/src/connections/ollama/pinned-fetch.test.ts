import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { pinnedHttpFetch, ResponseTooLarge } from "./pinned-fetch.js";

// The transport only: it is pointed at a loopback server here, which the guard (a separate step) would refuse.
let server: http.Server | undefined;
afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

async function serve(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("pinnedHttpFetch", () => {
  it("posts to the given address with the Host header as typed", async () => {
    let seen: Record<string, string | undefined> = {};
    const origin = await serve((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen = { host: req.headers.host, method: req.method, url: req.url, body };
        res.setHeader("content-type", "application/json");
        res.end('{"ok":true}');
      });
    });
    const response = await pinnedHttpFetch()(`${origin}/api/chat`, {
      method: "POST",
      headers: { host: "pc.tail1234.ts.net:11434", "content-type": "application/json" },
      body: '{"a":1}'
    });
    expect(await response.json()).toEqual({ ok: true });
    expect(seen).toEqual({ host: "pc.tail1234.ts.net:11434", method: "POST", url: "/api/chat", body: '{"a":1}' });
  });

  it("returns a redirect as it is and never follows it", async () => {
    let hits = 0;
    const origin = await serve((_req, res) => {
      hits++;
      res.writeHead(302, { location: "http://127.0.0.1:1/elsewhere" });
      res.end();
    });
    const response = await pinnedHttpFetch()(`${origin}/api/chat`, { method: "POST", body: "{}" });
    expect(response.status).toBe(302);
    expect(hits).toBe(1);
  });

  it("stops reading at the cap", async () => {
    const origin = await serve((_req, res) => res.end("x".repeat(5000)));
    await expect(pinnedHttpFetch(1000)(`${origin}/api/chat`, { method: "POST", body: "{}" })).rejects.toBeInstanceOf(
      ResponseTooLarge
    );
  });

  it("is cancelled by its signal", async () => {
    const origin = await serve(() => {});
    const controller = new AbortController();
    const pending = pinnedHttpFetch()(`${origin}/api/chat`, { method: "POST", body: "{}", signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toBeTruthy();
  });
});
