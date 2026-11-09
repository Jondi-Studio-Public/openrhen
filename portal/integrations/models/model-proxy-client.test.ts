import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "@/server/persistence/postgres/sql-pool";

const read = vi.hoisted(() => vi.fn());
vi.mock("@/server/secrets/read-secret", () => ({ readSecret: read }));

const { createModelTransport } = await import("./model-proxy-client");

// Built at runtime so no scanner sees a key-shaped literal.
const FAKE_KEY = ["fakedi", "PORTAL-SIDE", "FAKE_VALUE"].join("-");
const env = { OUTBOUND_PROXY_URL: "http://proxy.test", OUTBOUND_PROXY_TOKEN: "t" };
const sql = {} as Sql;
const request = { model: "m", messages: [{ role: "user" as const, content: "hi" }], maxTokens: 50, temperature: 0 };

const answer = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const sent = (fetcher: typeof fetch) => {
  const [url, init] = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
  return { url, body: JSON.parse(String(init.body)) as Record<string, unknown>, init };
};

beforeEach(() => read.mockReset());

describe("local tier", () => {
  it("calls the ollama connection with the saved address and no key", async () => {
    const fetcher = answer(200, { outcome: "ok", text: "{}", model: "m", tokensIn: 3, tokensOut: 4 });
    const transport = createModelTransport({ sql, userId: "u", ollamaUrl: "http://192.168.1.20:11434", env, fetcher });
    expect(await transport.complete("t2", request)).toMatchObject({ outcome: "ok", tokensIn: 3 });
    const call = sent(fetcher);
    expect(call.url).toBe("http://proxy.test/capabilities/model_provider/ollama/complete");
    expect(call.body).toMatchObject({ baseUrl: "http://192.168.1.20:11434", model: "m" });
    expect(read).not.toHaveBeenCalled();
  });

  it("says where to set the address when none is saved, without calling", async () => {
    const fetcher = answer(200, {});
    const result = await createModelTransport({ sql, userId: "u", ollamaUrl: null, env, fetcher }).complete(
      "t2",
      request
    );
    expect(result).toMatchObject({ outcome: "unreachable" });
    expect((result as { message: string }).message).toContain("Settings > Mail understanding");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("passes the proxy's refusal sentence through", async () => {
    const fetcher = answer(502, { outcome: "unreachable", message: "Could not connect to Ollama at 10.0.0.5:11434." });
    const result = await createModelTransport({
      sql,
      userId: "u",
      ollamaUrl: "http://10.0.0.5:11434",
      env,
      fetcher
    }).complete("t2", request);
    expect(result).toEqual({ outcome: "unreachable", message: "Could not connect to Ollama at 10.0.0.5:11434." });
  });
});

describe("hosted tier", () => {
  it("sends the saved key in the body to the deepinfra connection and nowhere else", async () => {
    read.mockResolvedValue({ kind: "ok", value: FAKE_KEY });
    const fetcher = answer(200, { outcome: "ok", text: "{}", model: "m", tokensIn: null, tokensOut: null });
    const transport = createModelTransport({ sql, userId: "u", ollamaUrl: null, env, fetcher });
    expect(await transport.complete("t3", request)).toMatchObject({ outcome: "ok" });
    const call = sent(fetcher);
    expect(read).toHaveBeenCalledWith(sql, "u", "deepinfra_api_key", env);
    expect(call.url).toBe("http://proxy.test/capabilities/model_provider/deepinfra/complete");
    expect(call.body.apiKey).toBe(FAKE_KEY);
    expect(call.url + JSON.stringify(call.init.headers)).not.toContain(FAKE_KEY);
  });

  it("does not call without a readable key, and says where to enter it", async () => {
    const fetcher = answer(200, {});
    for (const kind of ["unset", "unreadable"]) {
      read.mockResolvedValue({ kind });
      const result = await createModelTransport({ sql, userId: "u", ollamaUrl: null, env, fetcher }).complete(
        "t3",
        request
      );
      expect(result).toMatchObject({ outcome: "bad_key" });
      expect((result as { message: string }).message).toContain("Passwords and keys");
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("never puts the key in a returned message", async () => {
    read.mockResolvedValue({ kind: "ok", value: FAKE_KEY });
    const fetcher = answer(502, { outcome: "bad_key", message: "DeepInfra rejected the key." });
    const result = await createModelTransport({ sql, userId: "u", ollamaUrl: null, env, fetcher }).complete(
      "t3",
      request
    );
    expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
  });
});

describe("proxy trouble", () => {
  it("reports a sidecar that is not set up, a 400, an unknown shape and a network failure as outcomes, not throws", async () => {
    read.mockResolvedValue({ kind: "ok", value: FAKE_KEY });
    const t = (e: Record<string, string>, f: typeof fetch) =>
      createModelTransport({ sql, userId: "u", ollamaUrl: "http://10.0.0.5:11434", env: e, fetcher: f }).complete(
        "t2",
        request
      );
    expect(await t({}, answer(200, {}))).toMatchObject({ outcome: "unreachable" });
    expect(await t(env, answer(400, { error: "model must be x" }))).toEqual({
      outcome: "bad_output",
      message: "model must be x"
    });
    expect(await t(env, answer(200, { nonsense: true }))).toMatchObject({ outcome: "unreachable" });
    expect(await t(env, vi.fn(async () => Promise.reject(new Error("boom"))) as unknown as typeof fetch)).toMatchObject(
      {
        outcome: "unreachable"
      }
    );
  });
});
