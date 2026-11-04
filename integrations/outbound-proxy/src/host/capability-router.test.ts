import { createServer } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoundConnection, ConnectionImpl } from "./connection-api.js";
import { loadConnections, setConnectionHostForTests } from "./connection-host.js";
import { fakeManifest } from "./fake-connection.js";
import { routeCapability } from "./capability-router.js";
import { resetAiRateLimitForTests } from "./rate.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  setConnectionHostForTests(undefined);
  resetAiRateLimitForTests();
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function start(impl: ConnectionImpl, id = "fake_conn") {
  const bound: BoundConnection = { manifest: fakeManifest(id), create: () => impl };
  setConnectionHostForTests(loadConnections([bound], {}));
  const server = createServer((request, response) => {
    const controller = new AbortController();
    response.on("close", () => {
      if (!response.writableEnded) controller.abort();
    });
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    void (async () => {
      await routeCapability(request, response, controller, pathname);
    })();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no bind");
  return { url: `http://127.0.0.1:${address.port}`, port: address.port };
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("capability router", () => {
  it("runs a JSON op with the request body", async () => {
    const seen: unknown[] = [];
    const { url } = await start({
      travel_time: {
        matrix: {
          kind: "json",
          run: async (call) => {
            seen.push(call.body, call.pathname);
            return { status: 201, body: { ok: true } };
          }
        }
      }
    });
    const response = await post(`${url}/capabilities/travel_time/fake_conn/matrix`, { a: 1 });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
    expect(seen).toEqual([{ a: 1 }, "/capabilities/travel_time/fake_conn/matrix"]);
  });

  it("answers 404 for an unknown connection and an unsupported operation", async () => {
    const { url } = await start({
      travel_time: { matrix: { kind: "json", run: async () => ({ status: 200, body: {} }) } }
    });
    const unknown = await post(`${url}/capabilities/travel_time/nope/matrix`, {});
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).reason).toBe("unknown_connection");
    const unsupported = await post(`${url}/capabilities/travel_time/fake_conn/geocode`, {});
    expect(unsupported.status).toBe(404);
    expect((await unsupported.json()).reason).toBe("unsupported_operation");
    expect((await fetch(`${url}/capabilities/travel_time/fake_conn/matrix`)).status).toBe(404);
  });

  it("answers 404 for prototype-key op names", async () => {
    const { url } = await start({
      travel_time: { matrix: { kind: "json", run: async () => ({ status: 200, body: {} }) } }
    });
    for (const name of ["__proto__", "constructor"]) {
      const response = await post(`${url}/capabilities/travel_time/fake_conn/${name}`, {});
      expect(response.status, name).toBe(404);
      expect((await response.json()).reason).toBe("unsupported_operation");
    }
  });

  it("answers 413 for an oversized capability body", async () => {
    vi.stubEnv("OUTBOUND_MAX_BODY_BYTES", "10");
    const { url } = await start({
      travel_time: { matrix: { kind: "json", run: async () => ({ status: 200, body: {} }) } }
    });
    const response = await post(`${url}/capabilities/travel_time/fake_conn/matrix`, { padding: "x".repeat(100) });
    expect(response.status).toBe(413);
  });

  it("answers 429 for the embedding rate slot", async () => {
    vi.stubEnv("OUTBOUND_EMBEDDING_RATE_LIMIT_PER_MINUTE", "1");
    const { url } = await start({
      model_provider: { embed: { kind: "json", rate: "embedding", run: async () => ({ status: 200, body: {} }) } }
    });
    const path = `${url}/capabilities/model_provider/fake_conn/embed`;
    expect((await post(path, {})).status).toBe(200);
    const limited = await post(path, {});
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "Too many embedding requests; try again shortly." });
  });

  it("keeps the upstream message for a non-ok stream response and cancels its body", async () => {
    let cancelled = false;
    const { url } = await start({
      model_provider: {
        stream: {
          kind: "stream",
          run: async () => {
            // json() is overridden so the body stays unread: the router must cancel it.
            class Refused extends Response {
              override async json() {
                return { error: { message: "quota exceeded" } };
              }
            }
            return new Refused(new ReadableStream({ cancel: () => void (cancelled = true) }), { status: 429 });
          }
        }
      }
    });
    const response = await post(`${url}/capabilities/model_provider/fake_conn/stream`, {});
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "quota exceeded" });
    expect(cancelled).toBe(true);
  });

  it("answers 503 not_ready when create threw", async () => {
    const bound: BoundConnection = {
      manifest: fakeManifest("broken_conn"),
      create: () => {
        throw new Error("boom");
      }
    };
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      setConnectionHostForTests(loadConnections([bound], {}));
    } finally {
      process.stderr.write = write;
    }
    const { url } = await startWithCurrentHost();
    const response = await post(`${url}/capabilities/travel_time/broken_conn/matrix`, {});
    expect(response.status).toBe(503);
    expect((await response.json()).reason).toBe("not_ready");
  });

  it("answers 429 once the op's rate slot is spent, before reading the body", async () => {
    vi.stubEnv("OUTBOUND_AI_RATE_LIMIT_PER_MINUTE", "1");
    const { url } = await start({
      model_provider: { extract: { kind: "json", rate: "ai", run: async () => ({ status: 200, body: {} }) } }
    });
    const path = `${url}/capabilities/model_provider/fake_conn/extract`;
    expect((await post(path, {})).status).toBe(200);
    const limited = await post(path, {});
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "Too many AI requests; try again shortly." });
  });

  it("answers 400 for an invalid JSON body", async () => {
    const { url } = await start({
      travel_time: { matrix: { kind: "json", run: async () => ({ status: 200, body: {} }) } }
    });
    const response = await fetch(`${url}/capabilities/travel_time/fake_conn/matrix`, { method: "POST", body: "{nope" });
    expect(response.status).toBe(400);
  });

  it("pipes a stream op's three chunks and sets the event-stream headers", async () => {
    const { url } = await start({
      model_provider: {
        stream: {
          kind: "stream",
          run: async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  for (const text of ["data: 1\n\n", "data: 2\n\n", "data: 3\n\n"])
                    controller.enqueue(new TextEncoder().encode(text));
                  controller.close();
                }
              })
            )
        }
      }
    });
    const response = await post(`${url}/capabilities/model_provider/fake_conn/stream`, {});
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("data: 1\n\ndata: 2\n\ndata: 3\n\n");
  });

  it("answers a stream op's pre-stream failure as JSON", async () => {
    const { url } = await start({
      model_provider: {
        stream: { kind: "stream", run: async () => ({ status: 502, body: { error: "upstream down" } }) }
      }
    });
    const response = await post(`${url}/capabilities/model_provider/fake_conn/stream`, {});
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "upstream down" });
  });

  it("tears the connection down when a stream op goes idle after sending bytes", async () => {
    vi.stubEnv("OUTBOUND_STREAM_IDLE_TIMEOUT_MS", "750");
    const { port } = await start({
      model_provider: {
        stream: {
          kind: "stream",
          run: async (call) =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode("data: hi\n\n"));
                  // Never sends more; errors only when the router aborts the call.
                  call.signal.addEventListener("abort", () => controller.error(new Error("aborted")));
                }
              })
            )
        }
      }
    });
    const body = "{}";
    const received = await new Promise<{ bytes: string; closedWithinBudget: boolean }>((resolve, reject) => {
      let bytes = "";
      const startedAt = Date.now();
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(
          `POST /capabilities/model_provider/fake_conn/stream HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`
        );
      });
      socket.on("data", (chunk) => (bytes += chunk.toString("utf8")));
      socket.on("close", () => resolve({ bytes, closedWithinBudget: Date.now() - startedAt < 2000 }));
      socket.on("error", () => {});
      setTimeout(() => reject(new Error("Idle timeout did not close the connection within 2s.")), 2500);
    });
    expect(received.bytes).toContain("data: hi");
    expect(received.closedWithinBudget).toBe(true);
  });
});

async function startWithCurrentHost() {
  // Same server as `start`, reusing the host that the caller already set.
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    void routeCapability(request, response, new AbortController(), pathname);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no bind");
  return { url: `http://127.0.0.1:${address.port}` };
}
