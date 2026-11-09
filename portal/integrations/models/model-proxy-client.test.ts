import type { ModelProviderDescriptor } from "@openrhen/contracts";
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
    const transport = createModelTransport({
      sql,
      userId: "u",
      localAddress: "http://192.168.1.20:11434",
      env,
      fetcher
    });
    expect(await transport.complete("t2", request)).toMatchObject({ outcome: "ok", tokensIn: 3 });
    const call = sent(fetcher);
    expect(call.url).toBe("http://proxy.test/capabilities/model_provider/ollama/complete");
    expect(call.body).toMatchObject({ baseUrl: "http://192.168.1.20:11434", model: "m" });
    expect(read).not.toHaveBeenCalled();
  });

  it("says where to set the address when none is saved, without calling", async () => {
    const fetcher = answer(200, {});
    const result = await createModelTransport({ sql, userId: "u", localAddress: null, env, fetcher }).complete(
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
      localAddress: "http://10.0.0.5:11434",
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
    const transport = createModelTransport({ sql, userId: "u", localAddress: null, env, fetcher });
    expect(await transport.complete("t3", request)).toMatchObject({ outcome: "ok" });
    const call = sent(fetcher);
    expect(read).toHaveBeenCalledWith(sql, "u", "hosted_model_api_key", env);
    expect(call.url).toBe("http://proxy.test/capabilities/model_provider/deepinfra/complete");
    expect(call.body.apiKey).toBe(FAKE_KEY);
    expect(call.url + JSON.stringify(call.init.headers)).not.toContain(FAKE_KEY);
  });

  it("does not call without a readable key, and says where to enter it", async () => {
    const fetcher = answer(200, {});
    for (const kind of ["unset", "unreadable"]) {
      read.mockResolvedValue({ kind });
      const result = await createModelTransport({ sql, userId: "u", localAddress: null, env, fetcher }).complete(
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
    const result = await createModelTransport({ sql, userId: "u", localAddress: null, env, fetcher }).complete(
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
      createModelTransport({ sql, userId: "u", localAddress: "http://10.0.0.5:11434", env: e, fetcher: f }).complete(
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

describe("descriptors drive the transport", () => {
  const providers: { local: ModelProviderDescriptor; hosted: ModelProviderDescriptor } = {
    local: {
      tier: "local",
      connectionId: "fake-local",
      label: "LocalThing",
      body: { addressField: "where", fixed: { quick: true } }
    },
    hosted: {
      tier: "hosted",
      connectionId: "fake-host",
      label: "AcmeAI",
      secretName: "hosted_model_api_key",
      body: { keyField: "token", fixed: { region: "x" } }
    }
  };

  it("sends the local tier to the descriptor's connection and fields", async () => {
    const fetcher = answer(200, { outcome: "ok", text: "{}", model: "m", tokensIn: 1, tokensOut: 1 });
    await createModelTransport({
      sql,
      userId: "u",
      localAddress: "http://10.0.0.9:1",
      env,
      fetcher,
      providers
    }).complete("t2", request);
    const call = sent(fetcher);
    expect(call.url).toBe("http://proxy.test/capabilities/model_provider/fake-local/complete");
    expect(call.body).toMatchObject({ where: "http://10.0.0.9:1", quick: true });
    expect(call.body).not.toHaveProperty("baseUrl");
  });

  it("reads the descriptor's secret, puts it in the descriptor's key field and names the descriptor's label", async () => {
    read.mockResolvedValueOnce({ kind: "ok", value: FAKE_KEY });
    const fetcher = answer(200, { outcome: "ok", text: "{}", model: "m", tokensIn: 1, tokensOut: 1 });
    await createModelTransport({ sql, userId: "u", localAddress: null, env, fetcher, providers }).complete(
      "t3",
      request
    );
    expect(read).toHaveBeenCalledWith(sql, "u", "hosted_model_api_key", env);
    const call = sent(fetcher);
    expect(call.url).toBe("http://proxy.test/capabilities/model_provider/fake-host/complete");
    expect(call.body).toMatchObject({ token: FAKE_KEY, region: "x" });
    expect(call.body).not.toHaveProperty("apiKey");

    read.mockResolvedValueOnce({ kind: "unset" });
    const missing = await createModelTransport({
      sql,
      userId: "u",
      localAddress: null,
      env,
      fetcher,
      providers
    }).complete("t3", request);
    expect(missing).toMatchObject({ outcome: "bad_key" });
    expect(JSON.stringify(missing)).toContain("No AcmeAI key is saved");
  });
});
