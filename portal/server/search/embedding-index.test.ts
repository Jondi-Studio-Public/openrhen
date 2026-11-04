import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbeddingIndex, cosine, proxyEmbedder, type Embedder } from "./embedding-index";

const unit = (text: string) => Float32Array.from([text.length, 1]);

function recording(): { embedder: Embedder; calls: string[][] } {
  const calls: string[][] = [];
  return { calls, embedder: { embed: async (texts) => (calls.push([...texts]), texts.map(unit)) } };
}

afterEach(() => vi.unstubAllEnvs());

describe("embedding index", () => {
  it("embeds each distinct text once", async () => {
    const { embedder, calls } = recording();
    const index = new EmbeddingIndex({ embedder });
    await index.warm(["a", "bb", "a"]);
    await index.warm(["a", "bb", "ccc"]);
    expect(calls).toEqual([["a", "bb"], ["ccc"]]);
    expect(index.vector("bb")).toEqual(unit("bb"));
    expect(index.size).toBe(3);
  });

  it("drops vectors for text no longer in the plan once a pass succeeds", async () => {
    const { embedder, calls } = recording();
    const index = new EmbeddingIndex({ embedder });
    await index.warm(["old title", "kept"]);
    await index.warm(["new title", "kept"]);
    expect(index.vector("old title")).toBeUndefined();
    expect(index.vector("kept")).toBeDefined();
    expect(index.size).toBe(2);
    await index.warm(["kept"]);
    expect(index.size).toBe(1);
    expect(calls).toEqual([["old title", "kept"], ["new title"]]);
  });

  it("keeps what it had when a pass fails", async () => {
    let fail = false;
    const index = new EmbeddingIndex({
      embedder: {
        embed: async (texts) => {
          if (fail) throw new Error("proxy down");
          return texts.map(unit);
        }
      }
    });
    await index.warm(["a"]);
    fail = true;
    await expect(index.warm(["b"])).rejects.toThrow("proxy down");
    expect(index.vector("a")).toBeDefined();
  });

  it("lets a second caller join the pass already running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const calls: string[][] = [];
    const index = new EmbeddingIndex({
      embedder: { embed: async (texts) => (calls.push([...texts]), await gate, texts.map(unit)) }
    });
    const first = index.warm(["a", "b"]);
    const second = index.warm(["a", "b"]);
    release();
    await Promise.all([first, second]);
    expect(calls).toEqual([["a", "b"]]);
  });

  it("backs off after a failure and says why, then tries again", async () => {
    let now = 0;
    let fail = true;
    const index = new EmbeddingIndex({
      embedder: {
        embed: async (texts) => {
          if (fail) throw new Error("proxy down");
          return texts.map(unit);
        }
      },
      backoffMs: 1_000,
      now: () => now
    });
    await expect(index.embedQuery("q")).rejects.toThrow("proxy down");
    expect(index.unavailable()).toBe("proxy down");
    fail = false;
    await expect(index.warm(["a"])).rejects.toThrow("proxy down");
    now = 1_001;
    expect(index.unavailable()).toBeNull();
    await index.warm(["a"]);
    expect(index.vector("a")).toBeDefined();
  });

  it("gives up on a query embedding after its own timeout and backs off", async () => {
    const index = new EmbeddingIndex({ embedder: { embed: () => new Promise(() => undefined) } });
    await expect(index.embedQuery("q", 20)).rejects.toThrow("the embedding call took longer than 20 ms");
    expect(index.unavailable()).toBe("the embedding call took longer than 20 ms");
  });

  it("measures cosine similarity without trusting unit length", () => {
    expect(cosine(Float32Array.from([2, 0]), Float32Array.from([5, 0]))).toBeCloseTo(1);
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 3]))).toBeCloseTo(0);
    expect(cosine(Float32Array.from([0, 0]), Float32Array.from([1, 0]))).toBe(0);
  });
});

describe("proxy embedder", () => {
  it("refuses when the outbound proxy is not set up", async () => {
    vi.stubEnv("OUTBOUND_PROXY_URL", "");
    vi.stubEnv("OUTBOUND_PROXY_TOKEN", "");
    await expect(proxyEmbedder().embed(["a"])).rejects.toThrow("search by meaning is not set up on this server");
  });

  it("posts batches to the embed capability with the proxy token", async () => {
    vi.stubEnv("OUTBOUND_PROXY_URL", "http://proxy:8080");
    vi.stubEnv("OUTBOUND_PROXY_TOKEN", "proxy-token");
    const seen: { url: string; body: { texts: string[] }; auth: string }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { texts: string[] };
      seen.push({ url, body, auth: (init.headers as Record<string, string>).authorization! });
      return Response.json({ vectors: body.texts.map(() => [1, 0]) });
    }) as unknown as typeof fetch;
    const texts = Array.from({ length: 70 }, (_, i) => `t${i}`);
    const vectors = await proxyEmbedder(fetchImpl).embed(texts);
    expect(vectors).toHaveLength(70);
    expect(seen.map((call) => call.body.texts.length)).toEqual([64, 6]);
    expect(seen[0]).toMatchObject({
      url: "http://proxy:8080/capabilities/model_provider/deepinfra/embed",
      auth: "Bearer proxy-token"
    });
  });

  it("passes on the proxy's error", async () => {
    vi.stubEnv("OUTBOUND_PROXY_URL", "http://proxy:8080");
    vi.stubEnv("OUTBOUND_PROXY_TOKEN", "proxy-token");
    const fetchImpl = (async () =>
      Response.json({ error: "DEEPINFRA_API_KEY is not configured." }, { status: 400 })) as unknown as typeof fetch;
    await expect(proxyEmbedder(fetchImpl).embed(["a"])).rejects.toThrow("DEEPINFRA_API_KEY is not configured.");
  });
});
