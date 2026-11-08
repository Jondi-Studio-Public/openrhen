/**
 * The `ollama` connection: `model_provider.complete` against a language model on the person's own machine. There is
 * no key. The address arrives in each request's body (`baseUrl`) and goes through the guard in `guard.ts` before
 * anything is connected; the guard's rules and the fixed paths are in `client.ts`. Message text and model output are
 * never logged, and the proxy's request log carries the path only.
 */
import { connectionManifest } from "@openrhen/contracts";
import type { BoundConnection, OpCall } from "../../host/connection-api.js";
import { MODEL_ID, answer, parseCompleteInput } from "../../host/model-complete.js";
import { OLLAMA_TIMEOUT_MS, completeWithOllama } from "./client.js";
import { readOwnNetworks, type ResolveDeps } from "./guard.js";
import { pinnedHttpFetch } from "./pinned-fetch.js";

function manifest() {
  const found = connectionManifest("ollama");
  if (!found) throw new Error("The ollama manifest is missing from the registry.");
  return found;
}

export type OllamaSeams = ResolveDeps & { fetch?: (call: OpCall) => typeof fetch; timeoutMs?: number };

/** The connection with its seams open for tests: lookup, the own-subnet list and the transport. */
export function createOllamaConnection(seams: () => OllamaSeams): BoundConnection {
  return {
    manifest: manifest(),
    create: () => {
      const resolved = seams();
      return {
        model_provider: {
          complete: {
            kind: "json",
            rate: "local",
            // The host's backstop sits just past the op's own 180 s clock, so the op answers `timeout` itself.
            timeoutMs: OLLAMA_TIMEOUT_MS + 10_000,
            async run(call) {
              const body =
                typeof call.body === "object" && call.body !== null ? (call.body as Record<string, unknown>) : {};
              const parsed = parseCompleteInput(body, MODEL_ID, "an Ollama model name such as qwen3:14b");
              if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
              if (typeof body.baseUrl !== "string")
                return {
                  status: 400,
                  body: { error: "Send baseUrl, the http address of Ollama, for example http://192.168.1.20:11434." }
                };
              const result = await completeWithOllama(
                { ...parsed.input, baseUrl: body.baseUrl, withDigest: body.withDigest === true },
                {
                  ...(resolved.lookup ? { lookup: resolved.lookup } : {}),
                  ownNetworks: resolved.ownNetworks,
                  fetch: resolved.fetch?.(call) ?? pinnedHttpFetch(),
                  signal: call.signal,
                  ...(resolved.timeoutMs === undefined ? {} : { timeoutMs: resolved.timeoutMs })
                }
              );
              return answer(result);
            }
          }
        }
      };
    }
  };
}

// The proxy's own subnets are read when the host creates the connection, which is at start.
export const ollamaConnection: BoundConnection = createOllamaConnection(() => ({ ownNetworks: readOwnNetworks() }));
