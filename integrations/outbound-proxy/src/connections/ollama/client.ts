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
import { DEFAULT_OLLAMA_PORT, checkOllamaTarget, parseOllamaBaseUrl, type ResolveDeps } from "./guard.js";
import { InvalidUpstreamStatus, ResponseTooLarge } from "./pinned-fetch.js";

/** The paths this connection will ever call, fixed here. The address is the person's; the path never is. */
export const CHAT_PATH = "/api/chat";
/** The one GET: the model list, where Ollama documents each model's digest. */
export const TAGS_PATH = "/api/tags";
export const OLLAMA_TIMEOUT_MS = 180_000;

const START_OLLAMA =
  'Check that Ollama is running on that computer and listens on the network, not just on itself: in PowerShell run `setx OLLAMA_HOST "0.0.0.0:11434"`, quit Ollama from the tray, start it again, and allow port 11434 through Windows Firewall.';

export type OllamaInput = CompleteInput & { baseUrl: unknown; withDigest: boolean };
export type OllamaDeps = ResolveDeps & {
  /** Must connect to the URL it is given and nothing else: the URL already holds the checked address. */
  fetch: typeof fetch;
  signal: AbortSignal;
  timeoutMs?: number;
  /** Ports the operator allows; absent: 11434 only. */
  allowedPorts?: ReadonlySet<number>;
};

type OllamaReply = {
  message?: { content?: unknown };
  done_reason?: unknown;
  prompt_eval_count?: unknown;
  eval_count?: unknown;
};

const count = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null);

/** "about 3 seconds", or milliseconds under a second. */
const spoken = (ms: number) => (ms < 1000 ? `${ms} ms` : `about ${Math.round(ms / 1000)} seconds`);

async function call(
  fetcher: typeof fetch,
  origin: string,
  path: string,
  hostHeader: string,
  payload: unknown,
  signal: AbortSignal
): Promise<{ response: Response; bytes: Uint8Array | null }> {
  const response = await fetcher(`${origin}${path}`, {
    method: payload === undefined ? "GET" : "POST",
    redirect: "manual",
    headers: {
      host: hostHeader,
      accept: "application/json",
      ...(payload === undefined ? {} : { "content-type": "application/json" })
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
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
  const parsed = parseOllamaBaseUrl(input.baseUrl, deps.allowedPorts ?? new Set([DEFAULT_OLLAMA_PORT]));
  if (!parsed.ok) return fail("unreachable", parsed.message);
  const target = checkOllamaTarget(parsed, deps);
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
        TAGS_PATH,
        target.hostHeader,
        undefined,
        controller.signal
      );
      const refused = refusal(response.status, shown, input.model, false);
      if (refused) return refused;
      if (!bytes) return fail("bad_output", `Ollama at ${shown} sent a model list over 1 MiB, which is refused.`);
      digest = digestOf(bytes, input.model);
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
    const refused = refusal(response.status, shown, input.model, true);
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
        `Ollama at ${shown} did not finish within ${spoken(deps.timeoutMs ?? OLLAMA_TIMEOUT_MS)}. A model that is still loading can take minutes the first time: wait and retry, or use a smaller model.`
      );
    if (deps.signal.aborted) throw error;
    if (error instanceof InvalidUpstreamStatus)
      return fail(
        "bad_output",
        `The address ${shown} answered with an invalid HTTP status (${error.status}), so it is not Ollama. Check that the address and port are Ollama's, not another program's.`
      );
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

/** The digest of the requested model from `GET /api/tags`: `models[].digest` (64 hex), matched on `name` or `model`, with and without the `:latest` Ollama adds. Null when not found or not that shape. */
function digestOf(bytes: Uint8Array, model: string): string | null {
  let list: { models?: unknown };
  try {
    list = JSON.parse(new TextDecoder().decode(bytes)) as { models?: unknown };
  } catch {
    return null;
  }
  if (!Array.isArray(list.models)) return null;
  const wanted = new Set([model, model.includes(":") ? model.replace(/:latest$/, "") : `${model}:latest`]);
  for (const entry of list.models as { name?: unknown; model?: unknown; digest?: unknown }[]) {
    const names = [entry?.name, entry?.model];
    if (names.some((name) => typeof name === "string" && wanted.has(name)))
      return typeof entry.digest === "string" && /^[0-9a-f]{64}$/.test(entry.digest) ? entry.digest : null;
  }
  return null;
}

function refusal(status: number, shown: string, model: string, chat: boolean): CompleteResult | null {
  if (status >= 300 && status < 400)
    return fail(
      "unreachable",
      `Ollama at ${shown} answered with a redirect, which is refused. Use the address Ollama itself listens on.`
    );
  if (status === 404 && chat)
    return fail(
      "unreachable",
      `Ollama at ${shown} does not have the model "${model}". On that computer run \`ollama pull ${model}\`, then try again.`
    );
  if (status === 401 || status === 403)
    return fail(
      "bad_key",
      `The server at ${shown} asked for a login (${status}). Ollama itself needs none, so this is another program or a gateway in front of it; point baseUrl at Ollama directly.`
    );
  return failureForStatus(
    status,
    `Ollama at ${shown}`,
    "This is usually the model running out of memory or failing to load; try a smaller model."
  );
}

export { answer };
