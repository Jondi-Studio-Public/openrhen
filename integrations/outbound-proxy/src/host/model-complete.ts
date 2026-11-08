/**
 * What `model_provider.complete` means for every provider that implements it (Ollama, DeepInfra): one chat
 * completion in, one of six outcomes out. Nothing here logs. The proxy's request log carries the path only, and no
 * message text, model output or key is ever put into an outcome message or a thrown error.
 */

export const OUTCOMES = ["ok", "unreachable", "timeout", "bad_output", "rate_limited", "bad_key"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const MAX_MESSAGES = 16;
export const MAX_MESSAGE_CHARS = 32_000;
export const MAX_TOTAL_CHARS = 96_000;
export const MAX_OUTPUT_TOKENS = 4_096;
export const DEFAULT_OUTPUT_TOKENS = 1_024;
export const MAX_SCHEMA_CHARS = 8_000;
/** The reply is read up to this many bytes and no further. */
export const MAX_RESPONSE_BYTES = 1_048_576;

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
/** `"json"` asks for any JSON object; an object is a JSON schema the reply must follow. */
export type OutputFormat = "json" | Record<string, unknown>;

export type CompleteInput = {
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  format?: OutputFormat;
};

export type CompleteResult =
  | {
      outcome: "ok";
      text: string;
      model: string;
      tokensIn: number | null;
      tokensOut: number | null;
      digest?: string | null;
    }
  | { outcome: Exclude<Outcome, "ok">; message: string };

/** The HTTP status each outcome is answered with; the body always carries `outcome`. */
export const OUTCOME_STATUS: Record<Outcome, number> = {
  ok: 200,
  unreachable: 502,
  timeout: 504,
  bad_output: 502,
  rate_limited: 429,
  bad_key: 502
};

export function answer(result: CompleteResult): { status: number; body: unknown } {
  return { status: OUTCOME_STATUS[result.outcome], body: result };
}

export const fail = (outcome: Exclude<Outcome, "ok">, message: string): CompleteResult => ({ outcome, message });

const BAD_REQUEST =
  'Send { model, messages: [{ role, content }], maxTokens?, temperature?, format? } (1 to 16 messages, at most 96,000 characters in all, maxTokens up to 4096, temperature 0 to 2, format "json" or a JSON schema object under 8,000 characters)';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Model ids: letters, digits and `. _ : / @ -`, starting alphanumeric. */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;

/** The provider-neutral part of a request, or the exact sentence a 400 answers with. */
export function parseCompleteInput(
  body: Record<string, unknown>,
  modelPattern: RegExp,
  modelHint: string
): { ok: true; input: CompleteInput } | { ok: false; error: string } {
  const bad = (detail: string) => ({ ok: false as const, error: `${detail}. ${BAD_REQUEST}.` });
  const { model, messages, maxTokens, temperature, format } = body;
  if (typeof model !== "string" || !modelPattern.test(model)) return bad(`model must be ${modelHint}`);
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > MAX_MESSAGES)
    return bad("messages must be a list of 1 to 16");
  let total = 0;
  const parsed: ChatMessage[] = [];
  for (const entry of messages) {
    if (
      !isRecord(entry) ||
      (entry.role !== "system" && entry.role !== "user" && entry.role !== "assistant") ||
      typeof entry.content !== "string" ||
      entry.content.length === 0 ||
      entry.content.length > MAX_MESSAGE_CHARS
    )
      return bad(
        "each message needs a role (system, user or assistant) and non-empty content of at most 32,000 characters"
      );
    total += entry.content.length;
    parsed.push({ role: entry.role, content: entry.content });
  }
  if (total > MAX_TOTAL_CHARS) return bad("the messages are over 96,000 characters in all");
  if (
    maxTokens !== undefined &&
    (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_OUTPUT_TOKENS)
  )
    return bad("maxTokens must be a whole number from 1 to 4096");
  if (temperature !== undefined && (typeof temperature !== "number" || !(temperature >= 0 && temperature <= 2)))
    return bad("temperature must be a number from 0 to 2");
  let parsedFormat: OutputFormat | undefined;
  if (format !== undefined) {
    if (format === "json") parsedFormat = "json";
    else if (isRecord(format) && JSON.stringify(format).length <= MAX_SCHEMA_CHARS) parsedFormat = format;
    else return bad('format must be "json" or a JSON schema object under 8,000 characters');
  }
  return {
    ok: true,
    input: {
      model,
      messages: parsed,
      maxTokens: (maxTokens as number | undefined) ?? DEFAULT_OUTPUT_TOKENS,
      temperature: (temperature as number | undefined) ?? 0,
      ...(parsedFormat === undefined ? {} : { format: parsedFormat })
    }
  };
}

/** Reads a body up to `max` bytes. Null when it is bigger (the rest is not read). */
export async function readCapped(response: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/** The reply text must be a JSON object or array when a format was asked for. */
export function isJsonDocument(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null;
  } catch {
    return false;
  }
}

/** The status-to-outcome rules both providers share. Null means the status is a success. */
export function failureForStatus(status: number, who: string): CompleteResult | null {
  if (status >= 200 && status < 300) return null;
  if (status === 429)
    return fail(
      "rate_limited",
      `${who} is asking for a pause (429). Wait a minute and call again; do not retry in a loop.`
    );
  if (status === 408 || status === 504)
    return fail(
      "timeout",
      `${who} did not answer in time (${status}). Retry later, or use a smaller model or a shorter prompt.`
    );
  if (status === 502 || status === 503)
    return fail("unreachable", `${who} is not available right now (${status}). Retry in a few minutes.`);
  if (status >= 500)
    return fail(
      "bad_output",
      `${who} failed while answering (${status}). This is usually the model running out of memory or failing to load; try a smaller model.`
    );
  return fail("bad_output", `${who} rejected the request (${status}). Check the model id and the format.`);
}
