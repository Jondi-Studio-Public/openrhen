import { describe, expect, it, vi } from "vitest";
import type { OpCall, OpResult } from "../../host/connection-api.js";
import { deepinfraConnection } from "./connection.js";

const op = deepinfraConnection.create({}).model_provider!.complete!;
const KEY = ["fixture", "key", "aaaa"].join("-");
const base = { apiKey: KEY, model: "Qwen/Qwen3-235B-A22B-Instruct-2507", messages: [{ role: "user", content: "hi" }] };
const GOOD = {
  choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 9, completion_tokens: 2 }
};

const run = (body: unknown, fetcher: unknown, signal = new AbortController().signal) =>
  op.run({
    body,
    env: {},
    fetch: fetcher as typeof fetch,
    signal,
    pathname: "/capabilities/model_provider/deepinfra/complete"
  } satisfies OpCall) as Promise<OpResult>;
const reply = (body: unknown, status = 200) => vi.fn(async () => Response.json(body, { status }));

describe("deepinfra complete", () => {
  it("is its own hosted rate class and needs no environment key", () => {
    expect(op).toMatchObject({ kind: "json", rate: "hosted" });
  });

  it("answers ok, sending the key in the Authorization header only", async () => {
    const fetcher = reply(GOOD);
    const result = await run({ ...base, maxTokens: 200, temperature: 0.1, format: "json" }, fetcher);
    expect(result.status).toBe(502); // "hello" is not JSON
    const ok = await run(base, reply(GOOD));
    expect(ok).toEqual({
      status: 200,
      body: { outcome: "ok", text: "hello", model: base.model, tokensIn: 9, tokensOut: 2 }
    });
    const [url, init] = fetcher.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://api.deepinfra.com/v1/openai/chat/completions");
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(String(init.body)).not.toContain(KEY);
    expect(JSON.parse(String(init.body))).toEqual({
      model: base.model,
      messages: base.messages,
      max_tokens: 200,
      temperature: 0.1,
      stream: false,
      response_format: { type: "json_object" }
    });
  });

  it("passes a schema as json_schema", async () => {
    const fetcher = reply({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] });
    await run({ ...base, format: { type: "object" } }, fetcher);
    const init = (fetcher.mock.calls[0]! as unknown as [string, RequestInit])[1];
    expect(JSON.parse(String(init.body)).response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "output", schema: { type: "object" } }
    });
  });

  describe("outcomes", () => {
    const outcome = async (fetcher: unknown, body: unknown = base) => {
      const result = await run(body, fetcher);
      return { status: result.status, ...(result.body as { outcome: string; message: string }) };
    };
    it.each([[401], [403]])("bad_key: %i names where to paste a fresh key", async (status) => {
      const r = await outcome(reply({ error: { message: `Invalid token ${KEY}` } }, status));
      expect(r).toMatchObject({ outcome: "bad_key" });
      expect(r.message).toContain("Settings > Passwords and keys");
      expect(r.message).not.toContain(KEY);
    });
    it("bad_key: 402 says the balance is empty", async () => {
      expect((await outcome(reply({}, 402))).message).toContain("balance");
    });
    it("rate_limited: 429", async () => {
      expect(await outcome(reply({}, 429))).toMatchObject({ status: 429, outcome: "rate_limited" });
    });
    it("timeout: the op's clock", async () => {
      const fetcher = vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_r, reject) => init.signal!.addEventListener("abort", () => reject(new Error("x"))))
      );
      const { completeWithDeepInfra } = await import("./complete.js");
      const result = await completeWithDeepInfra(
        { model: base.model, messages: [{ role: "user", content: "hi" }], maxTokens: 10, temperature: 0 },
        KEY,
        fetcher as unknown as typeof fetch,
        new AbortController().signal,
        20
      );
      expect(result).toMatchObject({ outcome: "timeout" });
    });
    it("unreachable: a network failure drops the thrown text", async () => {
      const r = await outcome(
        vi.fn(async () => {
          throw new Error(`getaddrinfo ENOTFOUND, authorization: Bearer ${KEY}`);
        })
      );
      expect(r).toMatchObject({ status: 502, outcome: "unreachable" });
      expect(JSON.stringify(r)).not.toContain(KEY);
    });
    it("unreachable: 503", async () => {
      expect(await outcome(reply({}, 503))).toMatchObject({ outcome: "unreachable" });
    });
    it.each([
      ["a 404 names the model", reply({}, 404), "no model"],
      ["a 422", reply({}, 422), "rejected the request"],
      ["a 500", reply({}, 500), "failed while answering"],
      ["not JSON", vi.fn(async () => new Response("<html>")), "not JSON"],
      ["an empty reply", reply({ choices: [{ message: { content: "" } }] }), "empty reply"],
      ["no choices", reply({}), "empty reply"],
      [
        "a cut-off reply",
        reply({ choices: [{ message: { content: "partial" }, finish_reason: "length" }] }),
        "cut off"
      ],
      ["an oversize reply", vi.fn(async () => new Response("x".repeat(1_048_577))), "1 MiB"]
    ])("bad_output: %s", async (_name, fetcher, text) => {
      const r = await outcome(fetcher);
      expect(r).toMatchObject({ outcome: "bad_output" });
      expect(r.message).toContain(text);
    });
    it("rethrows when the caller's signal ended the call", async () => {
      const controller = new AbortController();
      const fetcher = vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_r, reject) => init.signal!.addEventListener("abort", () => reject(new Error("x"))))
      );
      const pending = run(base, fetcher, controller.signal);
      controller.abort();
      await expect(pending).rejects.toThrow("cancelled");
    });
  });

  describe("validation answers 400 without calling out, and never echoes the key", () => {
    it.each([
      ["no key", { ...base, apiKey: undefined }],
      ["a short key", { ...base, apiKey: "short" }],
      ["a key with a newline", { ...base, apiKey: "abcdefgh\nX-Evil: 1" }],
      ["a key with a space", { ...base, apiKey: "abcd efgh12345" }],
      ["a model without org", { ...base, model: "Qwen3" }],
      ["a model with a query", { ...base, model: "a/b?x=1" }],
      ["a model with a path escape", { ...base, model: "../../x/y" }],
      ["no messages", { ...base, messages: [] }],
      ["maxTokens 9999", { ...base, maxTokens: 9999 }]
    ])("%s", async (_name, body) => {
      const fetcher = reply(GOOD);
      const result = await run(body, fetcher);
      expect(result.status).toBe(400);
      expect(JSON.stringify(result.body)).not.toContain("abcdefgh");
      expect(fetcher).not.toHaveBeenCalled();
    });
  });
});
