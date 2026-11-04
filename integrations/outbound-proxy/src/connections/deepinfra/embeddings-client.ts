/**
 * Text embeddings for the portal's plan search, from
 * DeepInfra's OpenAI-compatible endpoint. The key lives on this container only, like every other
 * provider credential. Errors carry the status and the provider's `code`/`type`, never the body,
 * which could echo the text sent.
 *
 * Qwen3 embeddings are trained so that a prefix of the vector is itself a usable embedding, so each
 * vector is cut to `dimensions` and scaled back to unit length here: the portal keeps a quarter of
 * the memory and the response is a quarter of the size.
 */

export const DEEPINFRA_OPENAI_BASE_URL = "https://api.deepinfra.com/v1/openai";
export const DEFAULT_EMBEDDING_MODEL = "Qwen/Qwen3-Embedding-8B";
export const EMBEDDING_DIMENSIONS = 1024;
/** Per call: the portal sends at most this many texts, each at most `MAX_EMBEDDING_TEXT_CHARS`. */
export const MAX_EMBEDDING_TEXTS = 64;
export const MAX_EMBEDDING_TEXT_CHARS = 2_000;

export function deepInfraKeyFromEnv(env: Record<string, string | undefined> = process.env): string | null {
  return env.DEEPINFRA_API_KEY?.trim() || null;
}

export function embeddingModelFromEnv(env: Record<string, string | undefined> = process.env): string {
  return env.DEEPINFRA_EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;
}

/** Validates the portal's request body: `{ texts: string[] }`, non-empty, within the caps above. */
export function parseEmbeddingRequest(value: unknown): string[] | null {
  const texts = (value as { texts?: unknown } | null)?.texts;
  if (!Array.isArray(texts) || texts.length === 0 || texts.length > MAX_EMBEDDING_TEXTS) return null;
  if (!texts.every((text) => typeof text === "string" && text.length > 0 && text.length <= MAX_EMBEDDING_TEXT_CHARS))
    return null;
  return texts as string[];
}

/** The first `dimensions` values, scaled to unit length (a zero vector stays zero). */
export function truncateVector(vector: readonly number[], dimensions = EMBEDDING_DIMENSIONS): number[] {
  const cut = vector.slice(0, dimensions);
  const norm = Math.sqrt(cut.reduce((sum, value) => sum + value * value, 0));
  return norm === 0 ? cut : cut.map((value) => value / norm);
}

export async function embedTexts(
  texts: readonly string[],
  apiKey: string,
  model: string,
  fetchImpl: typeof fetch = fetch
): Promise<number[][]> {
  const response = await fetchImpl(`${DEEPINFRA_OPENAI_BASE_URL}/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input: texts, encoding_format: "float" })
  });
  if (!response.ok) {
    let code = "";
    try {
      const body = (await response.json()) as { error?: { code?: unknown; type?: unknown } };
      const raw = body.error?.code ?? body.error?.type;
      if (typeof raw === "string") code = ` (${raw})`;
    } catch {
      // No readable body: the status alone is enough.
    }
    throw new Error(`The embedding endpoint returned ${response.status}${code}.`);
  }
  const body = (await response.json()) as { data?: Array<{ index?: number; embedding?: unknown }> };
  const rows = [...(body.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  if (rows.length !== texts.length || rows.some((row) => !Array.isArray(row.embedding)))
    throw new Error("The embedding endpoint returned an unexpected number of vectors.");
  return rows.map((row) => truncateVector(row.embedding as number[]));
}
