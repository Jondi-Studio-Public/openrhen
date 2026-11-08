import { describe, expect, it, vi } from "vitest";
import type { OpCall, OpResult } from "../../host/connection-api.js";
import { parseOwnNetworks } from "./guard.js";
import { createOllamaConnection } from "./connection.js";

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
function setup(
  fetcher: FetchMock,
  extra: { lookup?: (h: string) => Promise<{ address: string; family: number }[]>; timeoutMs?: number } = {}
) {
  const connection = createOllamaConnection(() => ({
    ownNetworks: own,
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

  it("returns the digest from /api/show when asked, after checking it first", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      Response.json(String(url).endsWith("/api/show") ? { digest: "sha256:abc" } : GOOD)
    );
    const result = await setup(fetcher).run({ ...base, withDigest: true });
    expect(result.body).toMatchObject({ outcome: "ok", digest: "sha256:abc" });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "http://192.168.1.20:11434/api/show",
      "http://192.168.1.20:11434/api/chat"
    ]);
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

    it("a rebinding name is looked up once and the checked address is what is called", async () => {
      const answers = [[{ address: "192.168.1.20", family: 4 }], [{ address: "169.254.169.254", family: 4 }]];
      const lookup = vi.fn(async () => answers.shift()!);
      const fetcher = vi.fn<typeof fetch>(reply(GOOD));
      await setup(fetcher, { lookup }).run({ ...base, baseUrl: "http://rebind.example.net:11434", withDigest: true });
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
        "http://192.168.1.20:11434/api/show",
        "http://192.168.1.20:11434/api/chat"
      ]);
      expect((fetcher.mock.calls[0]![1]!.headers as Record<string, string>).host).toBe("rebind.example.net:11434");
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
