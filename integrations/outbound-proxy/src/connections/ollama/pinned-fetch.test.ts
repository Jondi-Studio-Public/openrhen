import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createServer as createTcpServer } from "node:net";
import { InvalidUpstreamStatus, pinnedHttpFetch, ResponseTooLarge } from "./pinned-fetch.js";

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

  it("rejects, rather than throwing out of the socket handler, when the status line is not a valid HTTP status", async () => {
    const uncaught: unknown[] = [];
    const record = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", record);
    try {
      for (const line of ["HTTP/1.1 999 X", "HTTP/1.1 099 Y", "HTTP/1.1 600 Z"]) {
        const raw = createTcpServer((socket) => {
          socket.once("data", () => socket.end(`${line}\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}`));
        });
        await new Promise<void>((resolve) => raw.listen(0, "127.0.0.1", resolve));
        const port = (raw.address() as AddressInfo).port;
        try {
          await expect(
            pinnedHttpFetch()(`http://127.0.0.1:${port}/api/chat`, { method: "POST", body: "{}" })
          ).rejects.toBeInstanceOf(InvalidUpstreamStatus);
        } finally {
          await new Promise<void>((resolve) => raw.close(() => resolve()));
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off("uncaughtException", record);
    }
    expect(uncaught).toEqual([]);
  });
});
