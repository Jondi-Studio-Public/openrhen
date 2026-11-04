import { describe, expect, it } from "vitest";
import { MAX_EMBEDDING_TEXTS, embedTexts, parseEmbeddingRequest, truncateVector } from "./embeddings-client.js";

describe("embeddings client", () => {
  it("accepts only a bounded list of non-empty texts", () => {
    expect(parseEmbeddingRequest({ texts: ["a", "b"] })).toEqual(["a", "b"]);
    expect(parseEmbeddingRequest({ texts: [] })).toBeNull();
    expect(parseEmbeddingRequest({ texts: [""] })).toBeNull();
    expect(parseEmbeddingRequest({ texts: [1] })).toBeNull();
    expect(parseEmbeddingRequest({ texts: Array(MAX_EMBEDDING_TEXTS + 1).fill("x") })).toBeNull();
    expect(parseEmbeddingRequest({ texts: ["x".repeat(2_001)] })).toBeNull();
    expect(parseEmbeddingRequest(null)).toBeNull();
  });

  it("cuts a vector to its prefix and scales it to unit length", () => {
    expect(truncateVector([3, 4, 12], 2)).toEqual([0.6, 0.8]);
    expect(truncateVector([0, 0, 1], 2)).toEqual([0, 0]);
  });

  it("sends the key only in the header and returns vectors in input order", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return Response.json({
        data: [
          { index: 1, embedding: [0, 2] },
          { index: 0, embedding: [2, 0] }
        ]
      });
    }) as unknown as typeof fetch;
    const vectors = await embedTexts(["first", "second"], "secret-key", "model-x", fetchImpl);
    expect(vectors).toEqual([
      [1, 0],
      [0, 1]
    ]);
    expect(seen!.url).toBe("https://api.deepinfra.com/v1/openai/embeddings");
    expect((seen!.init.headers as Record<string, string>).authorization).toBe("Bearer secret-key");
    expect(JSON.parse(String(seen!.init.body))).toEqual({
      model: "model-x",
      input: ["first", "second"],
      encoding_format: "float"
    });
  });

  it("reports a provider error by status and code, never the body", async () => {
    const fetchImpl = (async () =>
      Response.json(
        { error: { code: "rate_limited", message: "echo: first" } },
        { status: 429 }
      )) as unknown as typeof fetch;
    await expect(embedTexts(["first"], "k", "m", fetchImpl)).rejects.toThrow(
      "The embedding endpoint returned 429 (rate_limited)."
    );
  });

  it("refuses a reply with the wrong number of vectors", async () => {
    const fetchImpl = (async () => Response.json({ data: [] })) as unknown as typeof fetch;
    await expect(embedTexts(["first"], "k", "m", fetchImpl)).rejects.toThrow("unexpected number of vectors");
  });
});
