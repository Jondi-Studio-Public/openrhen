import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpCall, OpResult } from "../../host/connection-api.js";
import { parseOwnNetworks } from "./guard.js";
import { createOllamaConnection, ollamaConnection } from "./connection.js";

const own = parseOwnNetworks([{ cidr: "172.18.0.5/16" }]);
const GOOD = {
  message: { role: "assistant", content: "hello" },
  done: true,
  done_reason: "stop",
  prompt_eval_count: 12,
  eval_count: 3
};
const base = { baseUrl: "http://192.168.1.20:11434", model: "qwen3:14b", messages: [{ role: "user", content: "hi" }] };

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;
function setup(fetcher: FetchMock, extra: { timeoutMs?: number; ports?: ReadonlySet<number>; maxQueue?: number } = {}) {
  const connection = createOllamaConnection(() => ({
    ownNetworks: own,
    ports: new Set([11434]),
    fetch: () => fetcher as unknown as typeof fetch,
    ...extra
  }));
  const op = connection.create({}).model_provider!.complete!;
  const run = (body: unknown, signal = new AbortController().signal) =>
    op.run({
      body,
      env: {},
      fetch,
      signal,
      pathname: "/capabilities/model_provider/ollama/complete"
    } satisfies OpCall) as Promise<OpResult>;
  return { op, run };
}
const reply =
  (body: unknown, status = 200) =>
  async () =>
    Response.json(body, { status });

describe("ollama connection at start", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("fails to load, naming the variable, when OUTBOUND_OLLAMA_EXTRA_PORTS is malformed", () => {
    vi.stubEnv("OUTBOUND_OLLAMA_EXTRA_PORTS", "8000,80");
    expect(() => ollamaConnection.create({})).toThrow(/OUTBOUND_OLLAMA_EXTRA_PORTS/);
  });

  it("loads with 11434 alone when it is unset", () => {
    vi.stubEnv("OUTBOUND_OLLAMA_EXTRA_PORTS", "");
    expect(ollamaConnection.create({}).model_provider?.complete).toBeDefined();
  });
});

describe("ollama complete", () => {
  it("declares the local rate class and a timeout past its own 180 s clock", () => {
    const { op } = setup(vi.fn());
    expect(op).toMatchObject({ kind: "json", rate: "local", timeoutMs: 190_000 });
  });

  it("answers ok with the text, model and token counts, calling only the fixed chat path with the typed Host", async () => {
    const fetcher = vi.fn<typeof fetch>(reply(GOOD));
    const result = await setup(fetcher).run({
      ...base,
      maxTokens: 50,
      temperature: 0.2,
      format: "json",
      withDigest: false
    });
    // "hello" is not JSON, so a format request makes this bad_output; ask without a format here.
    expect(result.status).toBe(502);
    const ok = await setup(vi.fn<typeof fetch>(reply(GOOD))).run(base);
    expect(ok).toEqual({
      status: 200,
      body: { outcome: "ok", text: "hello", model: "qwen3:14b", tokensIn: 12, tokensOut: 3 }
    });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("http://192.168.1.20:11434/api/chat");
    expect(init).toMatchObject({ method: "POST", redirect: "manual" });
    expect((init!.headers as Record<string, string>).host).toBe("192.168.1.20:11434");
    expect(JSON.parse(String(init!.body))).toEqual({
      model: "qwen3:14b",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      format: "json",
      options: { num_predict: 50, temperature: 0.2 }
    });
  });

  describe("digest, from GET /api/tags", () => {
    const D = "a".repeat(64);
    const tags = (models: unknown) =>
      vi.fn<typeof fetch>(async (url) => Response.json(String(url).endsWith("/api/tags") ? { models } : GOOD));

    it("matches the entry by name, asks with GET and never touches /api/show", async () => {
      const fetcher = tags([
        { name: "other:1b", model: "other:1b", digest: "b".repeat(64) },
        { name: "qwen3:14b", model: "qwen3:14b", digest: D }
      ]);
      const result = await setup(fetcher).run({ ...base, withDigest: true });
      expect(result.body).toMatchObject({ outcome: "ok", digest: D });
      expect(fetcher.mock.calls.map(([url, init]) => [url, init!.method])).toEqual([
        ["http://192.168.1.20:11434/api/tags", "GET"],
        ["http://192.168.1.20:11434/api/chat", "POST"]
      ]);
      expect(fetcher.mock.calls[0]![1]!.body).toBeUndefined();
    });

    it("adds :latest for a bare id, and matches on the model field", async () => {
      const fetcher = tags([{ name: "x", model: "llama3:latest", digest: D }]);
      expect((await setup(fetcher).run({ ...base, model: "llama3", withDigest: true })).body).toMatchObject({
        digest: D
      });
    });

    it("drops :latest when the entry is listed bare", async () => {
      const fetcher = tags([{ name: "llama3", digest: D }]);
      expect((await setup(fetcher).run({ ...base, model: "llama3:latest", withDigest: true })).body).toMatchObject({
        digest: D
      });
    });

    it.each([
      ["a model that is not listed", [{ name: "other:1b", digest: "b".repeat(64) }]],
      ["a digest that is not 64 hex", [{ name: "qwen3:14b", digest: "sha256:abc" }]],
      ["no models array", undefined],
      ["a non-array", "nope"]
    ])("gives a null digest for %s, and the chat still runs", async (_name, models) => {
      const result = await setup(tags(models)).run({ ...base, withDigest: true });
      expect(result.body).toMatchObject({ outcome: "ok", digest: null });
    });

    it("does not ask for a digest unless withDigest is true", async () => {
      const fetcher = tags([]);
      await setup(fetcher).run(base);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("a failing model list is answered like any other failure, not as a missing model", async () => {
      const fetcher = vi.fn<typeof fetch>(reply({}, 404));
      const r = (await setup(fetcher).run({ ...base, withDigest: true })).body as { outcome: string; message: string };
      expect(r.outcome).toBe("bad_output");
      expect(r.message).not.toContain("ollama pull");
    });
  });

  it("accepts JSON output when a format was asked for", async () => {
    const fetcher = vi.fn<typeof fetch>(reply({ ...GOOD, message: { content: '{"facts":[]}' } }));
    expect((await setup(fetcher).run({ ...base, format: { type: "object" } })).body).toMatchObject({
      outcome: "ok",
      text: '{"facts":[]}'
    });
  });

  describe("outcomes", () => {
    const outcome = async (fetcher: FetchMock, extra?: Parameters<typeof setup>[1], body: unknown = base) => {
      const result = await setup(fetcher, extra).run(body);
      return { status: result.status, ...(result.body as { outcome: string; message: string }) };
    };

    it("unreachable: connection refused names the PowerShell fix", async () => {
      const r = await outcome(
        vi.fn<typeof fetch>(async () => {
          throw new TypeError("fetch failed ECONNREFUSED 192.168.1.20:11434");
        })
      );
      expect(r).toMatchObject({ status: 502, outcome: "unreachable" });
      expect(r.message).toContain("setx OLLAMA_HOST");
      expect(r.message).toContain("192.168.1.20:11434");
      expect(r.message).not.toContain("ECONNREFUSED");
    });

    it("unreachable: a missing model says how to pull it", async () => {
      const r = await outcome(vi.fn<typeof fetch>(reply({ error: "model not found" }, 404)));
      expect(r).toMatchObject({ outcome: "unreachable" });
      expect(r.message).toContain("ollama pull qwen3:14b");
    });

    it("unreachable: a redirect is refused and never followed", async () => {
      const fetcher = vi.fn<typeof fetch>(
        async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } })
      );
      const r = await outcome(fetcher);
      expect(r).toMatchObject({ outcome: "unreachable" });
      expect(r.message).toContain("redirect");
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("unreachable: 502 and 503", async () => {
      for (const status of [502, 503])
        expect(await outcome(vi.fn<typeof fetch>(reply({}, status)))).toMatchObject({ outcome: "unreachable" });
    });

    it("timeout: the op's own clock answers, and says a cold model is slow", async () => {
      const fetcher = vi.fn<typeof fetch>(
        (_url, init) =>
          new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("aborted"))))
      );
      const r = await outcome(fetcher, { timeoutMs: 20 });
      expect(r).toMatchObject({ status: 504, outcome: "timeout" });
      expect(r.message).toContain("loading");
      expect(r.message).toContain("20 ms");
      expect(r.message).not.toMatch(/within \d+ seconds/);
    });

    it("timeout: names the whole time allowed, not what was left after queueing", async () => {
      const fetcher = vi.fn<typeof fetch>(
        (_url, init) =>
          new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("aborted"))))
      );
      // The first reading is the op's start; every later one is 5 ms on, as if it waited in the queue.
      const real = Date.now.bind(Date);
      const t0 = real();
      let calls = 0;
      const now = vi.spyOn(Date, "now").mockImplementation(() => (calls++ === 0 ? t0 : t0 + 5));
      try {
        const r = await outcome(fetcher, { timeoutMs: 20 });
        expect(r).toMatchObject({ status: 504, outcome: "timeout" });
        expect(r.message).toContain("within 20 ms");
      } finally {
        now.mockRestore();
      }
    });

    it("timeout: 504 from a gateway", async () => {
      expect(await outcome(vi.fn<typeof fetch>(reply({}, 504)))).toMatchObject({ status: 504, outcome: "timeout" });
    });

    it("rate_limited: 429", async () => {
      expect(await outcome(vi.fn<typeof fetch>(reply({}, 429)))).toMatchObject({
        status: 429,
        outcome: "rate_limited"
      });
    });

    it("bad_key: a login wall in front of Ollama", async () => {
      const r = await outcome(vi.fn<typeof fetch>(reply({}, 401)));
      expect(r).toMatchObject({ outcome: "bad_key" });
      expect(r.message).toContain("point baseUrl at Ollama directly");
    });

    it.each([
      ["a 500", reply({ error: "out of memory" }, 500), "out of memory"],
      ["not JSON", async () => new Response("<html>nginx</html>"), "not Ollama's JSON"],
      ["an empty reply", reply({ message: { content: "" } }), "empty reply"],
      ["no message", reply({}), "empty reply"],
      ["a cut-off reply", reply({ ...GOOD, done_reason: "length" }), "cut off at maxTokens"]
    ])("bad_output: %s", async (_name, factory, text) => {
      const r = await outcome(vi.fn<typeof fetch>(factory as never));
      expect(r).toMatchObject({ outcome: "bad_output" });
      expect(r.message).toContain(text);
    });

    it("bad_output: JSON was asked for and the text is not JSON", async () => {
      const r = await outcome(vi.fn<typeof fetch>(reply(GOOD)), undefined, { ...base, format: "json" });
      expect(r).toMatchObject({ outcome: "bad_output" });
      expect(r.message).toContain("JSON");
    });

    it("bad_output: a reply over the 1 MiB cap is refused, by declared length and by actual size", async () => {
      const declared = vi.fn<typeof fetch>(
        async () => new Response("{}", { headers: { "content-length": String(2_000_000) } })
      );
      expect(await outcome(declared)).toMatchObject({ outcome: "bad_output" });
      const streamed = vi.fn<typeof fetch>(async () => new Response("x".repeat(1_048_577)));
      const r = await outcome(streamed);
      expect(r).toMatchObject({ outcome: "bad_output" });
      expect(r.message).toContain("1 MiB");
    });

    it("rethrows when the caller's own signal ended the call (the host answers that)", async () => {
      const controller = new AbortController();
      const fetcher = vi.fn<typeof fetch>(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            if (init!.signal!.aborted) reject(new Error("gone"));
            init!.signal!.addEventListener("abort", () => reject(new Error("gone")));
          })
      );
      const pending = setup(fetcher).run(base, controller.signal);
      controller.abort();
      await expect(pending).rejects.toThrow("gone");
    });
  });

  describe("the address guard runs before any connection", () => {
    it.each([
      "http://127.0.0.1:11434",
      "http://169.254.169.254",
      "http://172.18.0.2:11434",
      "http://postgres:11434",
      "http://engine-service:4100",
      "http://192.168.1.20:5432",
      "http://2130706433:11434",
      "http://user@192.168.1.20:11434",
      "https://192.168.1.20:11434",
      "http://8.8.8.8:11434"
    ])("%s is unreachable, with no fetch", async (baseUrl) => {
      const fetcher = vi.fn<typeof fetch>(reply(GOOD));
      const result = await setup(fetcher).run({ ...base, baseUrl });
      expect(result.status).toBe(502);
      expect(result.body).toMatchObject({ outcome: "unreachable" });
      expect(fetcher).not.toHaveBeenCalled();
    });

    it.each([
      "http://pc.tail1234.ts.net:11434",
      "http://rebind.example.net:11434",
      "http://192.168.1.20.nip.io:11434",
      "http://192.168.1.20:8000",
      "http://192.168.1.20:11435"
    ])("%s is refused: only IP literals, and only port 11434 by default", async (baseUrl) => {
      const fetcher = vi.fn<typeof fetch>(reply(GOOD));
      const result = await setup(fetcher).run({ ...base, baseUrl });
      expect(result.body).toMatchObject({ outcome: "unreachable" });
      expect(fetcher).not.toHaveBeenCalled();
    });

    it("an extra port the operator allowed works, and one they did not still does not", async () => {
      const ports = new Set([11434, 8000]);
      const fetcher = vi.fn<typeof fetch>(reply(GOOD));
      expect((await setup(fetcher, { ports }).run({ ...base, baseUrl: "http://10.0.0.5:8000" })).status).toBe(200);
      expect(fetcher.mock.calls[0]![0]).toBe("http://10.0.0.5:8000/api/chat");
      const refused = await setup(fetcher, { ports }).run({ ...base, baseUrl: "http://10.0.0.5:8001" });
      expect(refused.body).toMatchObject({ outcome: "unreachable" });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });

  describe("one call at a time", () => {
    const gate = () => {
      let open!: () => void;
      const opened = new Promise<void>((resolve) => (open = resolve));
      return { opened, open };
    };

    it("queues up to the bound, runs in order, and answers rate_limited past it", async () => {
      const g = gate();
      let active = 0;
      let peak = 0;
      const order: string[] = [];
      const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
        const id = JSON.parse(String(init!.body)).messages[0].content as string;
        active++;
        peak = Math.max(peak, active);
        order.push(id);
        await g.opened;
        active--;
        return Response.json(GOOD);
      });
      const { run } = setup(fetcher, { maxQueue: 1 });
      const msg = (id: string) => ({ ...base, messages: [{ role: "user", content: id }] });
      const first = run(msg("a"));
      await vi.waitFor(() => expect(order).toEqual(["a"]));
      const second = run(msg("b"));
      const third = await run(msg("c"));
      expect(third.status).toBe(429);
      expect(third.body).toMatchObject({ outcome: "rate_limited" });
      expect((third.body as { message: string }).message).toContain("one request at a time");
      expect(order).toEqual(["a"]);
      g.open();
      expect((await first).status).toBe(200);
      expect((await second).status).toBe(200);
      expect(order).toEqual(["a", "b"]);
      expect(peak).toBe(1);
    });

    it("frees the slot after a failure, so the next call runs", async () => {
      let n = 0;
      const fetcher = vi.fn<typeof fetch>(async () => {
        if (n++ === 0) throw new Error("boom");
        return Response.json(GOOD);
      });
      const { run } = setup(fetcher);
      expect((await run(base)).body).toMatchObject({ outcome: "unreachable" });
      expect((await run(base)).status).toBe(200);
    });

    it("a call cancelled while waiting leaves the line and does not block the next one", async () => {
      const g = gate();
      const fetcher = vi.fn<typeof fetch>(async () => {
        await g.opened;
        return Response.json(GOOD);
      });
      const { run } = setup(fetcher, { maxQueue: 1 });
      const first = run(base);
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
      const controller = new AbortController();
      const waiting = run(base, controller.signal);
      const rejected = expect(waiting).rejects.toThrow("cancelled");
      controller.abort();
      await rejected;
      const next = run(base);
      g.open();
      expect((await first).status).toBe(200);
      expect((await next).status).toBe(200);
    });

    it("time spent waiting counts against the 180 s clock", async () => {
      const g = gate();
      const fetcher = vi.fn<typeof fetch>(async () => {
        await g.opened;
        return Response.json(GOOD);
      });
      const { run } = setup(fetcher, { timeoutMs: 60 });
      const first = run(base);
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
      const second = run(base);
      await new Promise((resolve) => setTimeout(resolve, 90));
      g.open();
      await first;
      expect((await second).body).toMatchObject({ outcome: "timeout" });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });

  describe("a server that is not HTTP-valid cannot crash the proxy", () => {
    it("maps an invalid status to bad_output", async () => {
      const { InvalidUpstreamStatus } = await import("./pinned-fetch.js");
      const fetcher = vi.fn<typeof fetch>(async () => {
        throw new InvalidUpstreamStatus(999);
      });
      const r = (await setup(fetcher).run(base)).body as { outcome: string; message: string };
      expect(r.outcome).toBe("bad_output");
      expect(r.message).toContain("999");
      expect(r.message).toContain("not Ollama");
    });
  });

  describe("request validation answers 400 and never reaches the guard or the network", () => {
    it.each([
      ["no baseUrl", { model: base.model, messages: base.messages }],
      ["no model", { baseUrl: base.baseUrl, messages: base.messages }],
      ["a shell-ish model", { ...base, model: "x; rm -rf /" }],
      ["an empty model", { ...base, model: "" }],
      ["no messages", { ...base, messages: [] }],
      ["17 messages", { ...base, messages: Array(17).fill({ role: "user", content: "a" }) }],
      ["a bad role", { ...base, messages: [{ role: "tool", content: "a" }] }],
      ["empty content", { ...base, messages: [{ role: "user", content: "" }] }],
      ["huge content", { ...base, messages: [{ role: "user", content: "a".repeat(32_001) }] }],
      ["too much in all", { ...base, messages: Array(4).fill({ role: "user", content: "a".repeat(30_000) }) }],
      ["maxTokens 0", { ...base, maxTokens: 0 }],
      ["maxTokens 5000", { ...base, maxTokens: 5000 }],
      ["fractional maxTokens", { ...base, maxTokens: 1.5 }],
      ["temperature 3", { ...base, temperature: 3 }],
      ["format text", { ...base, format: "yaml" }],
      ["format huge", { ...base, format: { a: "x".repeat(9000) } }],
      ["a non-object body", "text"]
    ])("%s", async (_name, body) => {
      const fetcher = vi.fn<typeof fetch>(reply(GOOD));
      const result = await setup(fetcher).run(body);
      expect(result.status).toBe(400);
      expect((result.body as { error: string }).error).toMatch(/Send/);
      expect(fetcher).not.toHaveBeenCalled();
    });
  });

  it("never puts message text into an outcome, even when the provider fails", async () => {
    const secret = "my very private message about the mortgage";
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error(`failed for ${secret}`);
    });
    const result = await setup(fetcher).run({ ...base, messages: [{ role: "user", content: secret }] });
    expect(JSON.stringify(result)).not.toContain("mortgage");
  });
});
