import { describe, expect, it, vi } from "vitest";
import type { OpCall, OpResult } from "../../host/connection-api.js";
import { deepinfraConnection } from "./connection.js";

const embed = deepinfraConnection.create({}).model_provider!.embed!;

function call(body: unknown, fetcher: typeof fetch, env: Record<string, string | undefined>): OpCall {
  return { body, env, fetch: fetcher, signal: new AbortController().signal, pathname: "/ai/embeddings" };
}

describe("deepinfra connection", () => {
  it("is the embedding op with its own rate slot", () => {
    expect(embed).toMatchObject({ kind: "json", rate: "embedding" });
  });

  it("refuses a body that is not a bounded list of texts, before looking for a key", async () => {
    const result = (await embed.run(call({ texts: [] }, vi.fn() as unknown as typeof fetch, {}))) as OpResult;
    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toContain("Send { texts: string[] }");
  });

  it("needs DEEPINFRA_API_KEY", async () => {
    expect(await embed.run(call({ texts: ["a"] }, vi.fn() as unknown as typeof fetch, {}))).toEqual({
      status: 400,
      body: { error: "DEEPINFRA_API_KEY is not configured." }
    });
  });

  it("returns unit-length vectors, using the configured model", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ data: [{ index: 0, embedding: [3, 4] }] })
    );
    const result = await embed.run(
      call({ texts: ["a"] }, fetcher as unknown as typeof fetch, {
        DEEPINFRA_API_KEY: "k",
        DEEPINFRA_EMBEDDING_MODEL: "m"
      })
    );
    expect(result).toEqual({ status: 200, body: { vectors: [[0.6, 0.8]] } });
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({ model: "m", input: ["a"] });
  });

  it("answers an upstream failure as a 502 with the client's message", async () => {
    const fetcher = (async () => new Response("{}", { status: 429 })) as unknown as typeof fetch;
    expect(await embed.run(call({ texts: ["a"] }, fetcher, { DEEPINFRA_API_KEY: "k" }))).toEqual({
      status: 502,
      body: { error: "The embedding endpoint returned 429." }
    });
  });
});
