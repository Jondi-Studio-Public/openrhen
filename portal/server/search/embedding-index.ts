import { createHash } from "node:crypto";
import { resolveConnection } from "@openrhen/contracts";
import { callCapability, connectionHostConfigured } from "@/integrations/connection-host-client";

/**
 * Meaning vectors for plan search. The plan is about a
 * thousand short records, so there is no vector store: vectors live in this process, keyed by a hash of
 * the text they came from, and a search embeds only text it has not seen. A restart starts cold, which
 * costs one pass over the plan (about a tenth of a cent) the first time it is searched.
 *
 * Embedding goes through the outbound proxy's `model_provider.embed` op, so the DeepInfra key never enters the
 * portal. Vectors arrive cut to 1,024 dimensions and at unit length; they are kept as Float32Array.
 */

export interface Embedder {
  /** One unit-length vector per text, in order. Throws when the provider can't be reached. */
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

/** Why meaning search is unavailable when no embedder can be built at all. */
export class EmbedderUnavailableError extends Error {}

/** The proxy accepts at most this many texts per call (`MAX_EMBEDDING_TEXTS` there). */
const BATCH_SIZE = 64;
export const EMBED_TEXT_CHARS = 500;

export function proxyEmbedder(fetchImpl: typeof fetch = fetch): Embedder {
  return {
    async embed(texts) {
      if (!connectionHostConfigured())
        throw new EmbedderUnavailableError(
          "search by meaning is not set up on this server (the outbound proxy is missing)"
        );
      const out: Float32Array[] = [];
      for (let start = 0; start < texts.length; start += BATCH_SIZE) {
        const batch = texts.slice(start, start + BATCH_SIZE);
        const response = await callCapability({
          connectionId: resolveConnection("model_provider", "embed").id,
          capability: "model_provider",
          op: "embed",
          body: { texts: batch },
          fetcher: fetchImpl
        });
        const payload = response.body as { vectors?: unknown; error?: unknown } | null;
        if (!response.ok)
          throw new Error(typeof payload?.error === "string" ? payload.error : `the proxy returned ${response.status}`);
        const vectors = payload?.vectors;
        if (!Array.isArray(vectors) || vectors.length !== batch.length)
          throw new Error("the proxy returned an unexpected number of vectors");
        for (const vector of vectors) out.push(Float32Array.from(vector as number[]));
      }
      return out;
    }
  };
}

export function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Cosine similarity; both sides are unit length from the proxy, but a dot product alone would trust that. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export interface EmbeddingIndexOptions {
  embedder: Embedder;
  /** After a failure, skip meaning search for this long instead of retrying on every search. */
  backoffMs?: number;
  now?: () => number;
}

/**
 * The cache. `warm` embeds whatever texts are missing, one pass at a time (a second caller joins the
 * pass already running), and `vector` reads one back. A failed pass opens a backoff window, during which
 * `unavailable` says why and searches fall back to words.
 */
export class EmbeddingIndex {
  private readonly vectors = new Map<string, Float32Array>();
  private pass: Promise<void> | null = null;
  private failedUntil = -Infinity;
  private lastError = "";

  constructor(private readonly options: EmbeddingIndexOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Why meaning search is off right now, or null when it can be tried. */
  unavailable(): string | null {
    return this.now() < this.failedUntil ? this.lastError : null;
  }

  vector(text: string): Float32Array | undefined {
    return this.vectors.get(textHash(text));
  }

  get size(): number {
    return this.vectors.size;
  }

  /**
   * Embeds the texts not yet cached. Resolves when they are all in, or rejects on failure (and starts
   * the backoff). Texts that arrive while a pass runs wait for it, then get a pass of their own.
   * `texts` is always the whole plan, so once they are all in, a vector for any other text belongs to
   * a record since edited or deleted and is dropped: the cache tracks the plan instead of growing.
   */
  async warm(texts: readonly string[]): Promise<void> {
    while (this.pass) await this.pass.catch(() => undefined);
    if (this.unavailable() !== null) throw new Error(this.lastError);
    const wanted = new Map(texts.map((text) => [textHash(text), text]));
    const prune = () => {
      for (const hash of this.vectors.keys()) if (!wanted.has(hash)) this.vectors.delete(hash);
    };
    const missing = [...wanted.entries()].filter(([hash]) => !this.vectors.has(hash));
    if (missing.length === 0) return prune();
    const pass = (async () => {
      try {
        // Batch by batch, so a pass cut short by a failure keeps what it already paid for.
        for (let start = 0; start < missing.length; start += BATCH_SIZE) {
          const slice = missing.slice(start, start + BATCH_SIZE);
          const vectors = await this.options.embedder.embed(slice.map(([, text]) => text));
          slice.forEach(([hash], i) => this.vectors.set(hash, vectors[i]!));
        }
      } catch (error) {
        this.fail(error);
        throw error;
      }
    })();
    this.pass = pass;
    try {
      await pass;
      prune();
    } finally {
      if (this.pass === pass) this.pass = null;
    }
  }

  /**
   * One query's vector, uncached (queries rarely repeat). It gets `timeoutMs`, far less than the proxy
   * call's own timeout, so a hung provider costs a search a few seconds, not thirty. Failure, timeout
   * included, starts the backoff.
   */
  async embedQuery(text: string, timeoutMs = 4_000): Promise<Float32Array> {
    const reason = this.unavailable();
    if (reason !== null) throw new Error(reason);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`the embedding call took longer than ${timeoutMs} ms`)), timeoutMs);
      });
      const [vector] = await Promise.race([this.options.embedder.embed([text]), timeout]);
      if (!vector) throw new Error("no vector came back");
      return vector;
    } catch (error) {
      this.fail(error);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private fail(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error);
    this.failedUntil = this.now() + (this.options.backoffMs ?? 60_000);
  }
}
