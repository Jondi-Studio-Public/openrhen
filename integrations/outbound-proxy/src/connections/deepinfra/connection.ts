/**
 * The `deepinfra` connection: text embeddings (`model_provider.embed`) from DeepInfra's
 * OpenAI-compatible endpoint (DEEPINFRA_API_KEY stays in this process), and `complete`: a chat completion with the key
 * the person typed, sent in the request body.
 */
import { connectionManifest } from "@openrhen/contracts";
import type { BoundConnection } from "../../host/connection-api.js";
import { answer } from "../../host/model-complete.js";
import { completeWithDeepInfra, parseDeepInfraComplete } from "./complete.js";
import {
  MAX_EMBEDDING_TEXT_CHARS,
  MAX_EMBEDDING_TEXTS,
  deepInfraKeyFromEnv,
  embedTexts,
  embeddingModelFromEnv,
  parseEmbeddingRequest
} from "./embeddings-client.js";

function manifest() {
  const found = connectionManifest("deepinfra");
  if (!found) throw new Error("The deepinfra manifest is missing from the registry.");
  return found;
}

export const deepinfraConnection: BoundConnection = {
  manifest: manifest(),
  create: () => ({
    model_provider: {
      // The key arrives in the request body (typed in Settings, stored by the portal); this proxy's environment key is for embeddings only.
      complete: {
        kind: "json",
        rate: "hosted",
        async run(call) {
          const parsed = parseDeepInfraComplete(call.body);
          if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
          return answer(await completeWithDeepInfra(parsed.input, parsed.apiKey, call.fetch, call.signal));
        }
      },
      embed: {
        kind: "json",
        rate: "embedding",
        async run(call) {
          const texts = parseEmbeddingRequest(call.body);
          if (!texts)
            return {
              status: 400,
              body: {
                error: `Send { texts: string[] }: 1 to ${MAX_EMBEDDING_TEXTS} non-empty texts of at most ${MAX_EMBEDDING_TEXT_CHARS} characters.`
              }
            };
          const apiKey = deepInfraKeyFromEnv(call.env);
          if (!apiKey) return { status: 400, body: { error: "DEEPINFRA_API_KEY is not configured." } };
          try {
            return {
              status: 200,
              body: { vectors: await embedTexts(texts, apiKey, embeddingModelFromEnv(call.env), call.fetch) }
            };
          } catch (error) {
            // A timeout or a gone client aborted the call: the host answers that (504 or nothing).
            if (call.signal.aborted) throw error;
            return {
              status: 502,
              body: { error: error instanceof Error ? error.message : "The embedding call failed." }
            };
          }
        }
      }
    }
  })
};
