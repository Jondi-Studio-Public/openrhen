/**
 * The `openai` connection: an OpenAI Responses API passthrough (`/v1/responses`) serving the
 * `model_provider` ops `extract`, `stream` and `probe`. The caller's request body is forwarded
 * verbatim; OPENAI_API_KEY stays in this process.
 */
import { connectionManifest } from "@openrhen/contracts";
import type { BoundConnection, OpResult } from "../../host/connection-api.js";
import {
  extractImportDraft,
  openAIKeyFromEnv,
  OpenAITransportError,
  probeOpenAI,
  streamResponses
} from "./openai-client.js";

/**
 * Shown to the person when the OpenAI fetch fails at the transport level even after the one
 * automatic retry in openai-client.ts. Undici's own message for this ("fetch failed") is accurate
 * but not something anyone reading a chat panel should have to parse - the raw cause still reaches
 * the structured log via `logTransportFailure` below, just not this response body.
 */
export const TRANSPORT_FAILURE_MESSAGE = "Couldn't reach the assistant — try again.";

/**
 * The 502 body a transport failure produces is deliberately vague (see TRANSPORT_FAILURE_MESSAGE),
 * so the real cause - undici's "fetch failed" or whatever the underlying cause was - has to survive
 * somewhere. This is that somewhere. It is not suppressed under NODE_ENV=test: it only fires on an
 * actual transport failure, never on every request, so there is nothing to spam.
 */
export function logTransportFailure(pathname: string, error: OpenAITransportError) {
  process.stderr.write(
    `${JSON.stringify({
      level: "error",
      message: "OpenAI transport failure after retry",
      path: pathname,
      detail: error.message
    })}\n`
  );
}

const NOT_CONFIGURED: OpResult = { status: 400, body: { error: "OPENAI_API_KEY is not configured." } };

function manifest() {
  const found = connectionManifest("openai");
  if (!found) throw new Error("The openai manifest is missing from the registry.");
  return found;
}

export const openaiConnection: BoundConnection = {
  manifest: manifest(),
  create: () => ({
    model_provider: {
      extract: {
        kind: "json",
        rate: "ai",
        async run(call) {
          const apiKey = openAIKeyFromEnv(call.env);
          if (!apiKey) return NOT_CONFIGURED;
          try {
            return { status: 200, body: await extractImportDraft(call.body, apiKey, call.fetch) };
          } catch (error) {
            // A timeout or a gone client aborted the call: the host answers that (504 or nothing).
            if (call.signal.aborted) throw error;
            if (error instanceof OpenAITransportError) {
              logTransportFailure(call.pathname, error);
              return { status: 502, body: { error: TRANSPORT_FAILURE_MESSAGE } };
            }
            return {
              status: 502,
              body: { error: error instanceof Error ? error.message : "OpenAI extraction failed." }
            };
          }
        }
      },
      probe: {
        kind: "json",
        async run(call) {
          const apiKey = openAIKeyFromEnv(call.env);
          if (!apiKey) return NOT_CONFIGURED;
          try {
            const result = await probeOpenAI(apiKey, call.fetch);
            return { status: result.ok ? 200 : 502, body: result };
          } catch (error) {
            if (call.signal.aborted) throw error;
            return {
              status: 502,
              body: { ok: false, error: error instanceof Error ? error.message : "The OpenAI probe failed." }
            };
          }
        }
      },
      stream: {
        kind: "stream",
        rate: "ai",
        async run(call) {
          const apiKey = openAIKeyFromEnv(call.env);
          if (!apiKey) return NOT_CONFIGURED;
          try {
            const upstream = await streamResponses(call.body, apiKey, call.fetch);
            if (upstream.ok && upstream.body) return upstream;
            const payload = (await upstream.json().catch(() => null)) as { error?: { message?: string } } | null;
            return {
              status: 502,
              body: { error: payload?.error?.message ?? `OpenAI streaming failed (${upstream.status}).` }
            };
          } catch (error) {
            // The host answers a timeout (504) or a client abort (nothing) itself.
            if (call.signal.aborted) throw error;
            if (error instanceof OpenAITransportError) {
              logTransportFailure(call.pathname, error);
              return { status: 502, body: { error: TRANSPORT_FAILURE_MESSAGE } };
            }
            return {
              status: 502,
              body: { error: error instanceof Error ? error.message : "OpenAI streaming failed." }
            };
          }
        }
      }
    }
  })
};
