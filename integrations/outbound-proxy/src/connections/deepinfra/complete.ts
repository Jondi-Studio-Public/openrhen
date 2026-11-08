import {
  MAX_RESPONSE_BYTES,
  answer,
  fail,
  failureForStatus,
  isJsonDocument,
  parseCompleteInput,
  readCapped,
  type CompleteInput,
  type CompleteResult
} from "../../host/model-complete.js";

const ENDPOINT = "https://api.deepinfra.com/v1/openai/chat/completions";
/** The op's own clock; the host's 60 s upstream backstop sits above it. */
export const DEEPINFRA_COMPLETE_TIMEOUT_MS = 50_000;

/** `org/name`, e.g. `Qwen/Qwen3-235B-A22B-Instruct-2507`. */
export const DEEPINFRA_MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
/** Printable ASCII only, so the key can never carry a header break. */
const API_KEY = /^[\x21-\x7e]{8,256}$/;

export function parseDeepInfraComplete(
  body: unknown
): { ok: true; apiKey: string; input: CompleteInput } | { ok: false; error: string } {
  const record =
    typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  // The key's value is never put into a message; only its absence or shape is named.
  if (typeof record.apiKey !== "string" || !API_KEY.test(record.apiKey))
    return {
      ok: false,
      error: "Send apiKey, the DeepInfra key typed in Settings > Passwords and keys (printable characters, 8 to 256)."
    };
  const parsed = parseCompleteInput(
    record,
    DEEPINFRA_MODEL,
    "a DeepInfra model id of the form org/name, such as Qwen/Qwen3-235B-A22B-Instruct-2507"
  );
  return parsed.ok ? { ok: true, apiKey: record.apiKey, input: parsed.input } : parsed;
}

type Reply = {
  choices?: { message?: { content?: unknown }; finish_reason?: unknown }[];
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
};
const count = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null);

function responseFormat(format: CompleteInput["format"]) {
  if (format === undefined) return {};
  if (format === "json") return { response_format: { type: "json_object" } };
  return { response_format: { type: "json_schema", json_schema: { name: "output", schema: format } } };
}

/**
 * One chat completion on DeepInfra. The key goes in the Authorization header only. No text from DeepInfra (an error
 * body can quote the request) and no thrown message is passed on, so neither the key nor the prompt can leave here.
 */
export async function completeWithDeepInfra(
  input: CompleteInput,
  apiKey: string,
  fetcher: typeof fetch,
  signal: AbortSignal,
  timeoutMs = DEEPINFRA_COMPLETE_TIMEOUT_MS
): Promise<CompleteResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) controller.abort();
  try {
    const response = await fetcher(ENDPOINT, {
      method: "POST",
      redirect: "error",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        max_tokens: input.maxTokens,
        temperature: input.temperature,
        stream: false,
        ...responseFormat(input.format)
      }),
      signal: controller.signal
    });
    if (response.status === 401 || response.status === 403)
      return fail(
        "bad_key",
        "DeepInfra rejected the key. Paste a fresh key in Settings > Passwords and keys (DeepInfra), then try again."
      );
    if (response.status === 402)
      return fail("bad_key", "DeepInfra says the account has no balance. Add credit on deepinfra.com, then try again.");
    if (response.status === 404)
      return fail(
        "bad_output",
        `DeepInfra has no model "${input.model}". Pick a model id from deepinfra.com/models in Settings > Mail understanding.`
      );
    const refused = failureForStatus(response.status, "DeepInfra");
    if (refused) {
      await response.body?.cancel().catch(() => {});
      return refused;
    }
    const bytes = await readCapped(response, MAX_RESPONSE_BYTES);
    if (!bytes) return fail("bad_output", "DeepInfra sent a reply over 1 MiB, which is refused. Lower maxTokens.");
    let reply: Reply;
    try {
      reply = JSON.parse(new TextDecoder().decode(bytes)) as Reply;
    } catch {
      return fail("bad_output", "DeepInfra answered something that is not JSON. Try again in a few minutes.");
    }
    const choice = reply.choices?.[0];
    const text = choice?.message?.content;
    if (typeof text !== "string" || text.length === 0)
      return fail("bad_output", "DeepInfra returned an empty reply. Try again, or choose another model.");
    if (choice?.finish_reason === "length")
      return fail(
        "bad_output",
        `The reply was cut off at maxTokens (${input.maxTokens}). Raise maxTokens or ask for a shorter answer.`
      );
    if (input.format !== undefined && !isJsonDocument(text))
      return fail(
        "bad_output",
        "The model was asked for JSON and did not return a JSON object. Retry once; if it keeps happening use a larger model."
      );
    return {
      outcome: "ok",
      text,
      model: input.model,
      tokensIn: count(reply.usage?.prompt_tokens),
      tokensOut: count(reply.usage?.completion_tokens)
    };
  } catch {
    if (timedOut)
      return fail(
        "timeout",
        `DeepInfra did not answer within ${Math.round(timeoutMs / 1000)} seconds. Retry later, or use a smaller model.`
      );
    if (signal.aborted) throw new Error("The DeepInfra call was cancelled.");
    return fail("unreachable", "Could not reach DeepInfra. Check this computer's internet connection, then try again.");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

export { answer };
