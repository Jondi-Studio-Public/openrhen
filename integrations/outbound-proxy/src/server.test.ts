import { createServer } from "node:http";
import { connect } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { resetAiRateLimitForTests, takeAiRateSlot, takeEmbeddingRateSlot } from "./server.js";
import { json } from "./host/http.js";
import { handlerFailures, installServerHooks, servers, start } from "./server-test-support.js";
import { registerProxyRoute, unregisterProxyRoute } from "./host/route-registry.js";

installServerHooks();

describe("outbound integrations proxy boundary", () => {
  it("exposes health and readiness without a token", async () => {
    const url = await start();
    expect((await fetch(`${url}/health`)).status).toBe(200);
    expect((await fetch(`${url}/ready`)).status).toBe(200);
  });

  it("requires a bearer token for the proof route", async () => {
    const url = await start();
    expect((await fetch(`${url}/capabilities/calendar_source/google_calendar/proof`, { method: "POST" })).status).toBe(
      401
    );
  });

  it("refuses the compose placeholder as a token", async () => {
    const url = await start({ token: "replace-before-lan-use" });
    const response = await fetch(`${url}/capabilities/calendar_source/google_calendar/proof`, {
      method: "POST",
      body: "{}",
      headers: { authorization: "Bearer replace-before-lan-use" }
    });
    expect(response.status).toBe(401);
  });

  it("lists the bundled connections at /connections behind the bearer token", async () => {
    const url = await start();
    expect((await fetch(`${url}/connections`)).status).toBe(401);
    const response = await fetch(`${url}/connections`, { headers: { authorization: "Bearer test-token" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      connections: expect.arrayContaining([
        expect.objectContaining({ id: "google_calendar", label: "Google Calendar", capabilities: ["calendar_source"] }),
        expect.objectContaining({ id: "google", label: "Google Maps", capabilities: ["travel_time", "geocoding"] }),
        expect.objectContaining({ id: "pulse", label: "Pulse", capabilities: ["status_publish"] }),
        expect.objectContaining({ id: "openai", capabilities: ["model_provider"] }),
        expect.objectContaining({ id: "deepinfra", capabilities: ["model_provider"] }),
        expect.objectContaining({ id: "ollama", label: "Ollama", capabilities: ["model_provider"] })
      ])
    });
  });

  it("serves travel and pulse through the capability path", async () => {
    const url = await start();
    const headers = { authorization: "Bearer test-token", "content-type": "application/json" };
    const saved = { key: process.env.GOOGLE_MAPS_API_KEY, url: process.env.PULSE_PUBLISH_URL };
    delete process.env.GOOGLE_MAPS_API_KEY;
    delete process.env.PULSE_PUBLISH_URL;
    try {
      const post = (path: string, body: unknown) =>
        fetch(`${url}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
      const viaCapability = await post("/capabilities/geocoding/google/geocode", { query: "somewhere" });
      expect(viaCapability.status).toBe(400);
      expect(await viaCapability.json()).toEqual({ error: "GOOGLE_MAPS_API_KEY is not configured." });
      expect((await post("/capabilities/travel_time/google/matrix", {})).status).toBe(400);
      const config = await post("/capabilities/status_publish/pulse/config", {});
      expect(config.status).toBe(200);
      expect(await config.json()).toEqual({ configured: false, host: null });
      expect((await post("/capabilities/status_publish/pulse/publish", {})).status).toBe(503);
    } finally {
      if (saved.key !== undefined) process.env.GOOGLE_MAPS_API_KEY = saved.key;
      if (saved.url !== undefined) process.env.PULSE_PUBLISH_URL = saved.url;
    }
  });

  it("serves Google Calendar through the capability path", async () => {
    const url = await start();
    const headers = { authorization: "Bearer test-token", "content-type": "application/json" };
    const proof = await fetch(`${url}/capabilities/calendar_source/google_calendar/proof`, {
      method: "POST",
      headers,
      body: "{}"
    });
    expect(proof.status).toBe(200);
    expect(await proof.json()).toMatchObject({ status: "not_configured" });
    const window = {
      timeMin: "2026-10-01T00:00:00Z",
      timeMax: "2026-11-01T00:00:00Z",
      dateStart: "2026-10-01",
      dateEnd: "2026-11-01",
      calendarIds: ["a"]
    };
    const events = await fetch(`${url}/capabilities/calendar_source/google_calendar/read_events`, {
      method: "POST",
      headers,
      body: JSON.stringify(window)
    });
    expect(events.status).toBe(400);
    expect(await events.json()).toMatchObject({ reason: "not_configured" });
    const invalid = await fetch(`${url}/capabilities/calendar_source/google_calendar/read_events`, {
      method: "POST",
      headers,
      body: "{}"
    });
    expect(invalid.status).toBe(400);
  });

  it("no longer serves the pre-capability routes", async () => {
    const url = await start();
    const headers = { authorization: "Bearer test-token", "content-type": "application/json" };
    for (const [method, path] of [
      ["GET", "/proof"],
      ["POST", "/calendar-events"],
      ["GET", "/write-status"],
      ["GET", "/google-calendar/calendars"],
      ["POST", "/travel/matrix"],
      ["GET", "/pulse/config"],
      ["POST", "/ai/stream"],
      ["GET", "/probe/openai"]
    ] as const) {
      const response = await fetch(`${url}${path}`, { method, headers, body: method === "POST" ? "{}" : null });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });

  it("answers 404 for an unknown capability route", async () => {
    const url = await start();
    const response = await fetch(`${url}/capabilities/travel_time/nope/matrix`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: "{}"
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ reason: "unknown_connection" });
    expect((await fetch(`${url}/capabilities/travel_time/nope/matrix`, { method: "POST", body: "{}" })).status).toBe(
      401
    );
  });

  it("rate limits the paid AI routes", async () => {
    resetAiRateLimitForTests();
    vi.stubEnv("OUTBOUND_AI_RATE_LIMIT_PER_MINUTE", "2");
    expect(takeAiRateSlot(1000)).toBe(true);
    expect(takeAiRateSlot(1001)).toBe(true);
    expect(takeAiRateSlot(1002)).toBe(false);
    expect(takeAiRateSlot(62_000)).toBe(true);
    vi.unstubAllEnvs();
    resetAiRateLimitForTests();
  });

  it("answers 429 from the OpenAI extract op once the cap is spent", async () => {
    resetAiRateLimitForTests();
    vi.stubEnv("OUTBOUND_AI_RATE_LIMIT_PER_MINUTE", "1");
    vi.stubEnv("OPENAI_API_KEY", "");
    const url = await start();
    const call = () =>
      fetch(`${url}/capabilities/model_provider/openai/extract`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: "{}"
      });
    expect((await call()).status).toBe(400);
    expect((await call()).status).toBe(429);
    vi.unstubAllEnvs();
    resetAiRateLimitForTests();
  });

  it("serves complete for ollama and deepinfra behind the token; a denied address is answered without any connection", async () => {
    resetAiRateLimitForTests();
    const url = await start();
    const call = (id: string, body: unknown, token = "test-token") =>
      fetch(`${url}/capabilities/model_provider/${id}/complete`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body)
      });
    const messages = [{ role: "user", content: "hi" }];
    const denied = await call("ollama", { baseUrl: "http://169.254.169.254:11434", model: "qwen3:14b", messages });
    expect(denied.status).toBe(502);
    expect(await denied.json()).toMatchObject({ outcome: "unreachable", message: expect.stringContaining("metadata") });
    const compose = await call("ollama", { baseUrl: "http://postgres:11434", model: "qwen3:14b", messages });
    expect(await compose.json()).toMatchObject({ outcome: "unreachable" });
    expect((await call("ollama", { model: "qwen3:14b", messages })).status).toBe(400);
    expect((await call("deepinfra", { model: "a/b", messages })).status).toBe(400);
    expect((await call("ollama", {}, "wrong")).status).toBe(401);
  });

  it("validates the embed op and needs DEEPINFRA_API_KEY", async () => {
    resetAiRateLimitForTests();
    vi.stubEnv("DEEPINFRA_API_KEY", "");
    const url = await start();
    const call = (body: unknown) =>
      fetch(`${url}/capabilities/model_provider/deepinfra/embed`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify(body)
      });
    expect((await call({ texts: [] })).status).toBe(400);
    const missingKey = await call({ texts: ["Book dentist"] });
    expect(missingKey.status).toBe(400);
    expect(await missingKey.json()).toEqual({ error: "DEEPINFRA_API_KEY is not configured." });
    expect(
      (await fetch(`${url}/capabilities/model_provider/deepinfra/embed`, { method: "POST", body: "{}" })).status
    ).toBe(401);
    vi.unstubAllEnvs();
  });

  it("rate limits the embed op on its own cap", async () => {
    resetAiRateLimitForTests();
    vi.stubEnv("OUTBOUND_EMBEDDING_RATE_LIMIT_PER_MINUTE", "1");
    expect(takeEmbeddingRateSlot(1000)).toBe(true);
    expect(takeEmbeddingRateSlot(1001)).toBe(false);
    expect(takeAiRateSlot(1002)).toBe(true);
    vi.unstubAllEnvs();
    resetAiRateLimitForTests();
  });

  it("rejects an incorrect token", async () => {
    const url = await start();
    const response = await fetch(`${url}/capabilities/calendar_source/google_calendar/proof`, {
      method: "POST",
      body: "{}",
      headers: { authorization: "Bearer wrong-token" }
    });
    expect(response.status).toBe(401);
  });

  it("returns 404 for unknown routes", async () => {
    const url = await start();
    const response = await fetch(`${url}/nope`, { headers: { authorization: "Bearer test-token" } });
    expect(response.status).toBe(404);
  });

  it("pipes OpenAI stream bytes through the stream op untouched", async () => {
    const url = await start();
    const realFetch = globalThis.fetch;
    const upstreamBodies: string[] = [];
    // The test server is driven over real HTTP, so the stub must pass every non-OpenAI URL through.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes("api.openai.com")) return realFetch(input, init);
      upstreamBodies.push(String(init?.body));
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"hi"}\n\n'));
          controller.enqueue(encoder.encode('data: {"type":"response.completed"}\n\n'));
          controller.close();
        }
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
      process.env.OPENAI_API_KEY = "test-key";
      const response = await fetch(`${url}/capabilities/model_provider/openai/stream`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-test", stream: true })
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(await response.text()).toBe(
        'data: {"type":"response.output_text.delta","delta":"hi"}\n\ndata: {"type":"response.completed"}\n\n'
      );
      expect(JSON.parse(upstreamBodies[0]!)).toEqual({ model: "gpt-test", stream: true });
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.OPENAI_API_KEY;
    }
  });

  // A stale pooled keep-alive socket getting reset mid-request throws out of `fetch` itself, before
  // any response arrives - exactly the shape that showed the person a raw "fetch failed" instead of
  // a reply. One retry inside openai-client.ts should absorb this transparently.
  it("retries a transport failure once and still streams the reply", async () => {
    const url = await start();
    const realFetch = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes("api.openai.com")) return realFetch(input, init);
      attempts += 1;
      if (attempts === 1) throw new TypeError("fetch failed");
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"type":"response.completed"}\n\n'));
          controller.close();
        }
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
      process.env.OPENAI_API_KEY = "test-key";
      const response = await fetch(`${url}/capabilities/model_provider/openai/stream`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-test", stream: true })
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('data: {"type":"response.completed"}\n\n');
      expect(attempts).toBe(2);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.OPENAI_API_KEY;
    }
  });

  // Two transport failures in a row (the retry itself failed too) is the case that used to leak
  // undici's literal "fetch failed" into the chat panel. The response body should read like
  // something a person wrote, while the real cause still reaches the structured log.
  it("answers a still-failing transport with a friendly 502 and logs the raw error", async () => {
    const url = await start();
    const realFetch = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes("api.openai.com")) return realFetch(input, init);
      attempts += 1;
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      process.env.OPENAI_API_KEY = "test-key";
      const response = await fetch(`${url}/capabilities/model_provider/openai/stream`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-test", stream: true })
      });
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: "Couldn't reach the assistant — try again." });
      expect(attempts).toBe(2);
      const logged = stderrSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).toContain("fetch failed");
      expect(logged).not.toContain("try again");
    } finally {
      stderrSpy.mockRestore();
      globalThis.fetch = realFetch;
      delete process.env.OPENAI_API_KEY;
    }
  });

  // `readBody` is reached before any route's own try/catch, so a connection reset while the body is
  // still arriving rejects out of `handleRequest` itself - the shape of the portal container being
  // restarted mid-request. Unguarded that ended the process; the guard has to contain it and leave
  // the service answering.
  it("survives a client that resets the connection mid-body", async () => {
    const url = await start();
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", record);
    try {
      await new Promise<void>((resolve) => {
        const socket = connect(Number(new URL(url).port), "127.0.0.1", () => {
          // Promises a hundred bytes of body, sends ten, then vanishes.
          socket.write(
            "POST /capabilities/travel_time/google/matrix HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer test-token\r\nContent-Length: 100\r\n\r\n0123456789"
          );
          setTimeout(() => {
            socket.destroy();
            resolve();
          }, 50);
        });
        socket.on("error", () => {});
      });
      // Let the abort's rejection reach whichever handler is going to see it before judging.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(unhandled).toEqual([]);
      expect((handlerFailures[0] as NodeJS.ErrnoException | undefined)?.code).toBe("ECONNRESET");
      expect((await fetch(`${url}/health`)).status).toBe(200);
    } finally {
      process.off("unhandledRejection", record);
    }
  });
  it("reports /ready with a provider credential map, keyed off a placeholder value", async () => {
    const url = await start();
    const saved = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY };
    try {
      delete process.env.OPENAI_API_KEY;
      process.env.GOOGLE_MAPS_API_KEY = "replace-before-lan-use";
      const response = await fetch(`${url}/ready`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ready: true, providers: { openai: false, google: false } });
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key as keyof typeof saved];
        else process.env[key as keyof typeof saved] = value;
      }
    }
  });

  it("requires a bearer token for the Google Calendar routes", async () => {
    const url = await start();
    expect((await fetch(`${url}/capabilities/calendar_source/google_calendar/proof`, { method: "POST" })).status).toBe(
      401
    );
    expect(
      (await fetch(`${url}/capabilities/calendar_source/google_calendar/list_calendars`, { method: "POST" })).status
    ).toBe(401);
    expect(
      (await fetch(`${url}/capabilities/calendar_source/google_calendar/read_events`, { method: "POST" })).status
    ).toBe(401);
  });

  it("reports the Google Calendar proof as not_configured and the other routes as 400 with a reason", async () => {
    const url = await start();
    const headers = { authorization: "Bearer test-token", "content-type": "application/json" };
    const proof = await fetch(`${url}/capabilities/calendar_source/google_calendar/proof`, {
      method: "POST",
      body: "{}",
      headers
    });
    expect(proof.status).toBe(200);
    expect(await proof.json()).toMatchObject({
      status: "not_configured",
      missing: expect.arrayContaining(["GOOGLE_CALENDAR_REFRESH_TOKEN"])
    });
    const calendars = await fetch(`${url}/capabilities/calendar_source/google_calendar/list_calendars`, {
      method: "POST",
      body: "{}",
      headers
    });
    expect(calendars.status).toBe(400);
    expect(await calendars.json()).toMatchObject({ reason: "not_configured" });
    const events = await fetch(`${url}/capabilities/calendar_source/google_calendar/read_events`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        calendarIds: ["a"],
        timeMin: "2026-10-01T00:00:00Z",
        timeMax: "2026-11-01T00:00:00Z",
        dateStart: "2026-10-01",
        dateEnd: "2026-11-01"
      })
    });
    expect(events.status).toBe(400);
    expect(await events.json()).toMatchObject({ reason: "not_configured" });
  });

  it("validates the Google Calendar events body and maps an upstream failure to { error, reason }", async () => {
    const url = await start();
    const headers = { authorization: "Bearer test-token", "content-type": "application/json" };
    expect(
      (
        await fetch(`${url}/capabilities/calendar_source/google_calendar/read_events`, {
          method: "POST",
          headers,
          body: "{}"
        })
      ).status
    ).toBe(400);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes("googleapis.com")) return realFetch(input, init);
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }) as typeof fetch;
    try {
      process.env.GOOGLE_CALENDAR_CLIENT_ID = "id";
      process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "secret";
      process.env.GOOGLE_CALENDAR_REFRESH_TOKEN = "refresh";
      const response = await fetch(`${url}/capabilities/calendar_source/google_calendar/list_calendars`, {
        method: "POST",
        body: "{}",
        headers
      });
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: expect.any(String), reason: "invalid_grant" });
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.GOOGLE_CALENDAR_CLIENT_ID;
      delete process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
      delete process.env.GOOGLE_CALENDAR_REFRESH_TOKEN;
    }
  });

  it("rejects a request body over the byte cap with 413 and closes the connection", async () => {
    const url = await start();
    const saved = process.env.OUTBOUND_MAX_BODY_BYTES;
    process.env.OUTBOUND_MAX_BODY_BYTES = "10";
    try {
      const response = await fetch(`${url}/capabilities/geocoding/google/geocode`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ query: "somewhere with a name longer than ten bytes" })
      });
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: "payload_too_large" });
    } finally {
      if (saved === undefined) delete process.env.OUTBOUND_MAX_BODY_BYTES;
      else process.env.OUTBOUND_MAX_BODY_BYTES = saved;
    }
  });

  it("aborts the upstream connection when the client disconnects mid-stream", async () => {
    const url = await start();
    let upstreamAborted = false;
    const upstream = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"type":"response.output_text.delta","delta":"hi"}\n\n');
      req.on("aborted", () => {
        upstreamAborted = true;
      });
    });
    servers.push(upstream);
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("Fake upstream did not bind.");
    const upstreamUrl = `http://127.0.0.1:${upstreamAddress.port}`;

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes("api.openai.com")) return realFetch(input, init);
      return realFetch(upstreamUrl, init);
    }) as typeof fetch;

    try {
      process.env.OPENAI_API_KEY = "test-key";
      const requestBody = JSON.stringify({ model: "gpt-test", stream: true });
      await new Promise<void>((resolve) => {
        const socket = connect(Number(new URL(url).port), "127.0.0.1", () => {
          socket.write(
            `POST /capabilities/model_provider/openai/stream HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer test-token\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(requestBody)}\r\n\r\n${requestBody}`
          );
        });
        // Once the first bytes of the piped SSE response arrive, vanish without reading the rest —
        // the shape of a browser tab closing mid-stream.
        socket.once("data", () => {
          socket.destroy();
          resolve();
        });
        socket.on("error", () => {});
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(upstreamAborted).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("ends the stream when the upstream goes idle past the configured timeout", async () => {
    const url = await start();
    const upstream = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"type":"response.output_text.delta","delta":"hi"}\n\n');
      // Deliberately never writes another chunk or calls res.end() — the shape of a stalled upstream.
    });
    servers.push(upstream);
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("Fake upstream did not bind.");
    const upstreamUrl = `http://127.0.0.1:${upstreamAddress.port}`;

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes("api.openai.com")) return realFetch(input, init);
      return realFetch(upstreamUrl, init);
    }) as typeof fetch;
    const savedIdle = process.env.OUTBOUND_STREAM_IDLE_TIMEOUT_MS;
    // The idle clock runs from the moment the request arrives, before the upstream has sent even its
    // first chunk. A timeout too close to the connect time lets a slow runner trip it early: the
    // proxy then answers a 504 JSON body on a keep-alive socket, which stays open. 750 ms
    // leaves ample room for the first chunk and still closes well inside the 2 s budget.
    process.env.OUTBOUND_STREAM_IDLE_TIMEOUT_MS = "750";

    try {
      process.env.OPENAI_API_KEY = "test-key";
      // Headers and the first chunk go out fine, so a plain `fetch` would just hang waiting for the
      // rest — the idle timeout tears the socket down rather than sending a JSON error body once
      // bytes are already on the wire. A raw socket lets the test observe both: the first chunk
      // arrives, and the connection does not stay open forever once the upstream goes quiet.
      const requestBody = JSON.stringify({ model: "gpt-test", stream: true });
      const received = await new Promise<{ bytes: string; closedWithinBudget: boolean }>((resolve, reject) => {
        let bytes = "";
        const startedAt = Date.now();
        const socket = connect(Number(new URL(url).port), "127.0.0.1", () => {
          socket.write(
            `POST /capabilities/model_provider/openai/stream HTTP/1.1\r\nHost: x\r\nConnection: close\r\nAuthorization: Bearer test-token\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(requestBody)}\r\n\r\n${requestBody}`
          );
        });
        socket.on("data", (chunk) => {
          bytes += chunk.toString("utf8");
        });
        socket.on("close", () => resolve({ bytes, closedWithinBudget: Date.now() - startedAt < 2000 }));
        socket.on("error", () => {});
        setTimeout(() => reject(new Error("Idle timeout did not close the connection within 2s.")), 2500);
      });
      expect(received.bytes).toContain('"delta":"hi"');
      expect(received.closedWithinBudget).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.OPENAI_API_KEY;
      if (savedIdle === undefined) delete process.env.OUTBOUND_STREAM_IDLE_TIMEOUT_MS;
      else process.env.OUTBOUND_STREAM_IDLE_TIMEOUT_MS = savedIdle;
    }
  });
});

describe("routes registered by a drop-in", () => {
  it("answers one only after the bearer token, and 404s a path nobody registered", async () => {
    registerProxyRoute({
      method: "GET",
      path: "/drop-in-test/status",
      handle: async ({ response }) => json(response, 200, { from: "drop-in" })
    });
    try {
      const url = await start();
      expect((await fetch(`${url}/drop-in-test/status`)).status).toBe(401);
      const headers = { authorization: "Bearer test-token" };
      expect(await (await fetch(`${url}/drop-in-test/status`, { headers })).json()).toEqual({ from: "drop-in" });
      expect((await fetch(`${url}/drop-in-test/status`, { method: "POST", headers })).status).toBe(404);
      expect((await fetch(`${url}/drop-in-test/other`, { headers })).status).toBe(404);
    } finally {
      unregisterProxyRoute("GET", "/drop-in-test/status");
    }
  });
});

describe("push routes", () => {
  const pushEnvKeys = ["WEB_PUSH_VAPID_PUBLIC_KEY", "WEB_PUSH_VAPID_PRIVATE_KEY", "WEB_PUSH_SUBJECT"] as const;
  type SavedPushEnv = Record<(typeof pushEnvKeys)[number], string | undefined>;
  function savePushEnv(): SavedPushEnv {
    return Object.fromEntries(pushEnvKeys.map((key) => [key, process.env[key]])) as SavedPushEnv;
  }
  function restorePushEnv(saved: SavedPushEnv) {
    for (const key of pushEnvKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
  function setPushEnv() {
    process.env.WEB_PUSH_VAPID_PUBLIC_KEY =
      "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
    process.env.WEB_PUSH_VAPID_PRIVATE_KEY = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
    process.env.WEB_PUSH_SUBJECT = "mailto:ops@example.com";
  }

  it("answers 503 for both push routes when the keys are unset", async () => {
    const url = await start();
    const saved = savePushEnv();
    restorePushEnv({
      WEB_PUSH_VAPID_PUBLIC_KEY: undefined,
      WEB_PUSH_VAPID_PRIVATE_KEY: undefined,
      WEB_PUSH_SUBJECT: undefined
    });
    try {
      expect(
        (await fetch(`${url}/push/vapid-public-key`, { headers: { authorization: "Bearer test-token" } })).status
      ).toBe(503);
      const sendResponse = await fetch(`${url}/push/send`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: "{}"
      });
      expect(sendResponse.status).toBe(503);
    } finally {
      restorePushEnv(saved);
    }
  });

  it("returns the configured public key", async () => {
    const url = await start();
    const saved = savePushEnv();
    setPushEnv();
    try {
      const response = await fetch(`${url}/push/vapid-public-key`, { headers: { authorization: "Bearer test-token" } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ publicKey: process.env.WEB_PUSH_VAPID_PUBLIC_KEY });
    } finally {
      restorePushEnv(saved);
    }
  });

  it("refuses a push send whose endpoint host is not on the allowlist", async () => {
    const url = await start();
    const saved = savePushEnv();
    setPushEnv();
    try {
      const response = await fetch(`${url}/push/send`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({
          subscription: {
            endpoint: "https://evil.example.com/push/abc",
            keys: {
              p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
              auth: "BTBZMqHH6r4Tts7J_aSIgg"
            }
          },
          payload: JSON.stringify({ title: "t", body: "b", tag: "x", url: "/now" }),
          ttlSeconds: 60,
          urgency: "high"
        })
      });
      expect(response.status).toBe(400);
    } finally {
      restorePushEnv(saved);
    }
  });

  it("validates the send request body", async () => {
    const url = await start();
    const saved = savePushEnv();
    setPushEnv();
    try {
      const response = await fetch(`${url}/push/send`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: "{}"
      });
      expect(response.status).toBe(400);
    } finally {
      restorePushEnv(saved);
    }
  });

  it("sends to an allowlisted endpoint and maps the upstream response", async () => {
    const url = await start();
    const saved = savePushEnv();
    setPushEnv();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("fcm.googleapis.com")) return new Response(null, { status: 201 });
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      const response = await fetch(`${url}/push/send`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({
          subscription: {
            endpoint: "https://fcm.googleapis.com/fcm/send/abc",
            keys: {
              p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
              auth: "BTBZMqHH6r4Tts7J_aSIgg"
            }
          },
          payload: JSON.stringify({ title: "t", body: "b", tag: "x", url: "/now" }),
          ttlSeconds: 60,
          urgency: "high"
        })
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ outcome: "delivered", httpStatus: 201 });
    } finally {
      globalThis.fetch = realFetch;
      restorePushEnv(saved);
    }
  });
});

describe("pulse routes", () => {
  const pulseEnvKeys = ["PULSE_PUBLISH_URL", "PULSE_PUBLISH_SECRET"] as const;
  type SavedPulseEnv = Record<(typeof pulseEnvKeys)[number], string | undefined>;
  function savePulseEnv(): SavedPulseEnv {
    return Object.fromEntries(pulseEnvKeys.map((key) => [key, process.env[key]])) as SavedPulseEnv;
  }
  function restorePulseEnv(saved: SavedPulseEnv) {
    for (const key of pulseEnvKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
  function setPulseEnv() {
    process.env.PULSE_PUBLISH_URL = "https://tracker.example.com/api/pulse";
    process.env.PULSE_PUBLISH_SECRET = "test-secret";
  }
  const validPulse = {
    v: 1,
    seq: 1,
    generatedAt: "2026-09-26T14:00:00.000Z",
    state: "on",
    since: "2026-09-26T13:00:00.000Z",
    private: false,
    shares: {
      today: { onPercent: 60, countedMinutes: 300 },
      days7: { onPercent: 55, countedMinutes: 2000 },
      days30: { onPercent: 50, countedMinutes: 8000 }
    }
  };

  it("reports not configured when the env is unset", async () => {
    const url = await start();
    const saved = savePulseEnv();
    restorePulseEnv({ PULSE_PUBLISH_URL: undefined, PULSE_PUBLISH_SECRET: undefined });
    try {
      const response = await fetch(`${url}/capabilities/status_publish/pulse/config`, {
        method: "POST",
        body: "{}",
        headers: { authorization: "Bearer test-token" }
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ configured: false, host: null });
      const publishResponse = await fetch(`${url}/capabilities/status_publish/pulse/publish`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify(validPulse)
      });
      expect(publishResponse.status).toBe(503);
    } finally {
      restorePulseEnv(saved);
    }
  });

  it("refuses a non-https PULSE_PUBLISH_URL as unconfigured", async () => {
    const url = await start();
    const saved = savePulseEnv();
    process.env.PULSE_PUBLISH_URL = "http://tracker.example.com/api/pulse";
    process.env.PULSE_PUBLISH_SECRET = "test-secret";
    try {
      const response = await fetch(`${url}/capabilities/status_publish/pulse/config`, {
        method: "POST",
        body: "{}",
        headers: { authorization: "Bearer test-token" }
      });
      expect(await response.json()).toEqual({ configured: false, host: null });
    } finally {
      restorePulseEnv(saved);
    }
  });

  it("reports the configured host without the full URL", async () => {
    const url = await start();
    const saved = savePulseEnv();
    setPulseEnv();
    try {
      const response = await fetch(`${url}/capabilities/status_publish/pulse/config`, {
        method: "POST",
        body: "{}",
        headers: { authorization: "Bearer test-token" }
      });
      expect(await response.json()).toEqual({ configured: true, host: "tracker.example.com" });
    } finally {
      restorePulseEnv(saved);
    }
  });

  it("refuses a pulse object with an extra field", async () => {
    const url = await start();
    const saved = savePulseEnv();
    setPulseEnv();
    try {
      const response = await fetch(`${url}/capabilities/status_publish/pulse/publish`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ ...validPulse, location: "Home" })
      });
      expect(response.status).toBe(400);
    } finally {
      restorePulseEnv(saved);
    }
  });

  it("accepts a pulse object whose state is unknown, and still refuses an unnamed state", async () => {
    const url = await start();
    const saved = savePulseEnv();
    setPulseEnv();
    const realFetch = globalThis.fetch;
    let sentBody: string | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("tracker.example.com")) {
        sentBody = String(init?.body);
        return new Response(null, { status: 200 });
      }
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      const post = (body: unknown) =>
        fetch(`${url}/capabilities/status_publish/pulse/publish`, {
          method: "POST",
          headers: { authorization: "Bearer test-token", "content-type": "application/json" },
          body: JSON.stringify(body)
        });
      const unknownPulse = { ...validPulse, state: "unknown" };
      const accepted = await post(unknownPulse);
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toEqual({ outcome: "delivered", httpStatus: 200 });
      expect(sentBody).toBe(JSON.stringify(unknownPulse));
      const refused = await post({ ...validPulse, state: "lapsed" });
      expect(refused.status).toBe(400);
    } finally {
      globalThis.fetch = realFetch;
      restorePulseEnv(saved);
    }
  });

  it("signs and sends a valid pulse object, mapping the upstream response", async () => {
    const url = await start();
    const saved = savePulseEnv();
    setPulseEnv();
    const realFetch = globalThis.fetch;
    let sentBody: string | undefined;
    let sentHeaders: HeadersInit | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("tracker.example.com")) {
        sentBody = String(init?.body);
        sentHeaders = init?.headers;
        return new Response(null, { status: 200 });
      }
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      const response = await fetch(`${url}/capabilities/status_publish/pulse/publish`, {
        method: "POST",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify(validPulse)
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ outcome: "delivered", httpStatus: 200 });
      expect(sentBody).toBe(JSON.stringify(validPulse));
      expect((sentHeaders as Record<string, string>)["pulse-signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    } finally {
      globalThis.fetch = realFetch;
      restorePulseEnv(saved);
    }
  });
});
