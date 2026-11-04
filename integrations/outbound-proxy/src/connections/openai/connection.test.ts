import { describe, expect, it, vi } from "vitest";
import type { OpCall, OpResult } from "../../host/connection-api.js";
import { openaiConnection, TRANSPORT_FAILURE_MESSAGE } from "./connection.js";

const env = { OPENAI_API_KEY: "sk-test" };

function call(
  body: unknown,
  fetcher: typeof fetch,
  options: { env?: Record<string, string | undefined>; signal?: AbortSignal } = {}
): OpCall {
  return {
    body,
    env: options.env ?? env,
    fetch: fetcher,
    signal: options.signal ?? new AbortController().signal,
    pathname: "/ai/stream"
  };
}

const ops = openaiConnection.create({}).model_provider!;

describe("openai connection", () => {
  it("declares extract, stream and probe, with the AI rate slot on the billed ones", () => {
    expect(Object.keys(ops).sort()).toEqual(["extract", "probe", "stream"]);
    expect(ops.extract).toMatchObject({ kind: "json", rate: "ai" });
    expect(ops.probe).toMatchObject({ kind: "json" });
    expect(ops.probe!.rate).toBeUndefined();
    expect(ops.stream).toMatchObject({ kind: "stream", rate: "ai" });
  });

  it("answers 400 without a key, for every op", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    for (const op of Object.values(ops)) {
      const result = (await op.run(call({}, fetcher, { env: {} }))) as OpResult;
      expect(result).toEqual({ status: 400, body: { error: "OPENAI_API_KEY is not configured." } });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("forwards the extract body verbatim to the Responses API", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({ output_text: "{}" }));
    const result = await ops.extract!.run(call({ model: "m", input: "x" }, fetcher as unknown as typeof fetch));
    expect(result).toEqual({ status: 200, body: { output_text: "{}" } });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(JSON.parse(String(init?.body))).toEqual({ model: "m", input: "x" });
  });

  it("passes OpenAI's own error message through as a 502", async () => {
    const fetcher = (async () =>
      Response.json({ error: { message: "bad key" } }, { status: 401 })) as unknown as typeof fetch;
    expect(await ops.extract!.run(call({}, fetcher))).toEqual({ status: 502, body: { error: "bad key" } });
  });

  it("maps a transport failure to the vague message and logs the cause", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const fetcher = (async () => {
        throw new Error("fetch failed");
      }) as unknown as typeof fetch;
      expect(await ops.extract!.run(call({}, fetcher))).toEqual({
        status: 502,
        body: { error: TRANSPORT_FAILURE_MESSAGE }
      });
      expect(await ops.stream!.run(call({}, fetcher))).toEqual({
        status: 502,
        body: { error: TRANSPORT_FAILURE_MESSAGE }
      });
      expect(String(write.mock.calls[0]?.[0])).toContain("/ai/stream");
    } finally {
      write.mockRestore();
    }
  });

  it("rethrows a failure caused by an abort, so the host answers it", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = (async () => {
      throw new Error("aborted");
    }) as unknown as typeof fetch;
    await expect(ops.extract!.run(call({}, fetcher, { signal: controller.signal }))).rejects.toThrow();
    await expect(ops.stream!.run(call({}, fetcher, { signal: controller.signal }))).rejects.toThrow();
  });

  it("probes with the model listing: 200 when reachable, 502 with the detail when not", async () => {
    const ok = (async () => Response.json({ data: [] })) as unknown as typeof fetch;
    expect(await ops.probe!.run(call({}, ok))).toEqual({ status: 200, body: { ok: true } });
    const refused = (async () =>
      Response.json({ error: { message: "nope" } }, { status: 403 })) as unknown as typeof fetch;
    expect(await ops.probe!.run(call({}, refused))).toEqual({ status: 502, body: { ok: false, detail: "nope" } });
    const down = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    expect(await ops.probe!.run(call({}, down))).toEqual({ status: 502, body: { ok: false, error: "down" } });
  });

  it("returns the upstream Response untouched when the stream opens, and a 502 body when it does not", async () => {
    const sse = new Response("data: x\n\n", { headers: { "content-type": "text/event-stream" } });
    const opened = await ops.stream!.run(call({ stream: true }, (async () => sse) as unknown as typeof fetch));
    expect(opened).toBe(sse);
    const refused = (async () =>
      Response.json({ error: { message: "overloaded" } }, { status: 503 })) as unknown as typeof fetch;
    expect(await ops.stream!.run(call({}, refused))).toEqual({ status: 502, body: { error: "overloaded" } });
    const unreadable = (async () => new Response("<html>", { status: 500 })) as unknown as typeof fetch;
    expect(await ops.stream!.run(call({}, unreadable))).toEqual({
      status: 502,
      body: { error: "OpenAI streaming failed (500)." }
    });
  });
});
