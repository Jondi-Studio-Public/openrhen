import {
  MAX_RESPONSE_BYTES,
  answer,
  fail,
  failureForStatus,
  isJsonDocument,
  readCapped,
  type CompleteInput,
  type CompleteResult
} from "../../host/model-complete.js";
import { parseOllamaBaseUrl, resolveOllamaTarget, type ResolveDeps } from "./guard.js";
import { ResponseTooLarge } from "./pinned-fetch.js";

/** The paths this connection will ever call, fixed here. The address is the person's; the path never is. */
export const CHAT_PATH = "/api/chat";
export const SHOW_PATH = "/api/show";
export const OLLAMA_TIMEOUT_MS = 180_000;

const START_OLLAMA =
  'Check that Ollama is running on that computer and listens on the network, not just on itself: in PowerShell run `setx OLLAMA_HOST "0.0.0.0:11434"`, quit Ollama from the tray, start it again, and allow port 11434 through Windows Firewall.';

export type OllamaInput = CompleteInput & { baseUrl: unknown; withDigest: boolean };
export type OllamaDeps = ResolveDeps & {
  /** Must connect to the URL it is given and nothing else: the URL already holds the checked address. */
  fetch: typeof fetch;
  signal: AbortSignal;
  timeoutMs?: number;
};

type OllamaReply = {
  message?: { content?: unknown };
  done_reason?: unknown;
  prompt_eval_count?: unknown;
  eval_count?: unknown;
};

const count = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null);

async function call(
  fetcher: typeof fetch,
  origin: string,
  path: string,
  hostHeader: string,
  payload: unknown,
  signal: AbortSignal
): Promise<{ response: Response; bytes: Uint8Array | null }> {
  const response = await fetcher(`${origin}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { host: hostHeader, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(payload),
    signal
  });
  const status = response.status;
  if (status >= 300 && status < 400) {
    await response.body?.cancel().catch(() => {});
    return { response, bytes: new Uint8Array() };
  }
  return { response, bytes: await readCapped(response, MAX_RESPONSE_BYTES) };
}

/** One chat completion on the person's Ollama. Never throws for an outcome; rethrows only when the caller's own signal ended the call. */
export async function completeWithOllama(input: OllamaInput, deps: OllamaDeps): Promise<CompleteResult> {
  const parsed = parseOllamaBaseUrl(input.baseUrl);
  if (!parsed.ok) return fail("unreachable", parsed.message);
  const target = await resolveOllamaTarget(parsed, deps);
  if (!target.ok) return fail("unreachable", target.message);

  const shown = `${parsed.host}:${parsed.port}`;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, deps.timeoutMs ?? OLLAMA_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  deps.signal.addEventListener("abort", onAbort, { once: true });
  if (deps.signal.aborted) controller.abort();

  try {
    let digest: string | null | undefined;
    if (input.withDigest) {
      const { response, bytes } = await call(
        deps.fetch,
        target.origin,
        SHOW_PATH,
        target.hostHeader,
        { model: input.model },
        controller.signal
      );
      const refused = refusal(response.status, shown, input.model);
      if (refused) return refused;
      if (!bytes)
        return fail("bad_output", `Ollama at ${shown} sent a model description over 1 MiB, which is refused.`);
      try {
        const shownBody = JSON.parse(new TextDecoder().decode(bytes)) as { digest?: unknown };
        digest = typeof shownBody.digest === "string" ? shownBody.digest : null;
      } catch {
        digest = null;
      }
    }

    const { response, bytes } = await call(
      deps.fetch,
      target.origin,
      CHAT_PATH,
      target.hostHeader,
      {
        model: input.model,
        messages: input.messages,
        stream: false,
        ...(input.format === undefined ? {} : { format: input.format }),
        options: { num_predict: input.maxTokens, temperature: input.temperature }
      },
      controller.signal
    );
    const refused = refusal(response.status, shown, input.model);
    if (refused) return refused;
    if (!bytes)
      return fail(
        "bad_output",
        `Ollama at ${shown} sent a reply over 1 MiB, which is refused. Lower maxTokens or ask for less.`
      );
    let reply: OllamaReply;
    try {
      reply = JSON.parse(new TextDecoder().decode(bytes)) as OllamaReply;
    } catch {
      return fail(
        "bad_output",
        `The address ${shown} answered something that is not Ollama's JSON. Check that the address and port are Ollama's, not another program's.`
      );
    }
    const text = reply.message?.content;
    if (typeof text !== "string" || text.length === 0)
      return fail(
        "bad_output",
        `Ollama at ${shown} returned an empty reply. Try again, or use a model that follows the prompt.`
      );
    if (reply.done_reason === "length")
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
      tokensIn: count(reply.prompt_eval_count),
      tokensOut: count(reply.eval_count),
      ...(digest === undefined ? {} : { digest })
    };
  } catch (error) {
    if (timedOut)
      return fail(
        "timeout",
        `Ollama at ${shown} did not finish within ${Math.round((deps.timeoutMs ?? OLLAMA_TIMEOUT_MS) / 1000)} seconds. A model that is still loading can take minutes the first time: wait and retry, or use a smaller model.`
      );
    if (deps.signal.aborted) throw error;
    if (error instanceof ResponseTooLarge)
      return fail(
        "bad_output",
        `Ollama at ${shown} sent a reply over 1 MiB, which is refused. Lower maxTokens or ask for less.`
      );
    // The thrown message is dropped: it is not needed and could echo the address back in a form we did not check.
    return fail("unreachable", `Could not connect to Ollama at ${shown}. ${START_OLLAMA}`);
  } finally {
    clearTimeout(timer);
    deps.signal.removeEventListener("abort", onAbort);
  }
}

function refusal(status: number, shown: string, model: string): CompleteResult | null {
  if (status >= 300 && status < 400)
    return fail(
      "unreachable",
      `Ollama at ${shown} answered with a redirect, which is refused. Use the address Ollama itself listens on.`
    );
  if (status === 404)
    return fail(
      "unreachable",
      `Ollama at ${shown} does not have the model "${model}". On that computer run \`ollama pull ${model}\`, then try again.`
    );
  if (status === 401 || status === 403)
    return fail(
      "bad_key",
      `The server at ${shown} asked for a login (${status}). Ollama itself needs none, so this is another program or a gateway in front of it; point baseUrl at Ollama directly.`
    );
  return failureForStatus(status, `Ollama at ${shown}`);
}

export { answer };
