/**
 * The `openai` connection's client: an OpenAI Responses API passthrough (`POST /v1/responses`, plus
 * the key-checking model listing). It forwards the caller's request body verbatim and does not claim
 * to be any wider "OpenAI-compatible" provider contract; that is a phase 2 item.
 */

export function openAIKeyFromEnv(env: Record<string, string | undefined> = process.env) {
  return env.OPENAI_API_KEY?.trim() || null;
}

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const TRANSPORT_RETRY_DELAY_MS = 250;

/**
 * Thrown when the OpenAI Responses fetch fails at the transport level - twice in a row, since one
 * retry already happened underneath. This is not an OpenAI error (those resolve with a non-ok status,
 * they don't throw): it's the shape of a stale pooled keep-alive socket getting reset mid-request, or
 * any other failure before a single response byte arrives. Callers use this to show the person a
 * plain "couldn't reach it" message instead of undici's internal "fetch failed", while still logging
 * the real cause.
 */
export class OpenAITransportError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "OpenAITransportError";
    this.cause = cause;
  }
}

/**
 * Retries exactly once when `fetch` itself throws. An HTTP-level error from OpenAI (4xx/5xx) resolves
 * normally rather than throwing, so it is never retried here - only a genuine transport failure
 * (connection reset, DNS blip, etc.) before any response arrived is. `init.body` is a plain JSON
 * string in both call sites below, so reusing it across the retry is safe - nothing has consumed it.
 */
async function fetchWithTransportRetry(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch {
    await sleep(TRANSPORT_RETRY_DELAY_MS);
    try {
      return await fetchImpl(url, init);
    } catch (secondError) {
      throw new OpenAITransportError(secondError);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A cheap reachability check: OpenAI's model listing costs no tokens and needs no request body, so it
 * proves the key and the network path without exercising anything billed. Used only when nothing else
 * recently proved the provider reachable — see the portal's provider-call-recorder.
 */
export async function probeOpenAI(
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; detail?: string }> {
  const response = await fetchImpl("https://api.openai.com/v1/models", {
    method: "GET",
    headers: { authorization: `Bearer ${apiKey}` }
  });
  if (response.ok) return { ok: true };
  const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  return { ok: false, detail: payload?.error?.message ?? `OpenAI returned ${response.status}.` };
}

/**
 * Forwards a Responses API request expecting SSE and returns the upstream response untouched. A
 * transport failure here is retried once, before any headers (let alone bytes) have arrived, so it
 * is always safe: nothing has been streamed to the client yet.
 */
export async function streamResponses(
  body: unknown,
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  return fetchWithTransportRetry(
    OPENAI_RESPONSES_URL,
    {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(body)
    },
    fetchImpl
  );
}

/** Forwards an OpenAI Responses API request body verbatim and returns the parsed JSON response. */
export async function extractImportDraft(
  body: unknown,
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<unknown> {
  const response = await fetchWithTransportRetry(
    OPENAI_RESPONSES_URL,
    {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body)
    },
    fetchImpl
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? (payload as { error?: { message?: string } }).error?.message
        : undefined;
    throw new Error(message ?? `OpenAI extraction failed (${response.status}).`);
  }
  return payload;
}
