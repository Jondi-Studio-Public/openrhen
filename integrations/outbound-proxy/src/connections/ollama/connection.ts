/**
 * The `ollama` connection: `model_provider.complete` against a language model on the person's own machine. There is
 * no key. The address arrives in each request's body (`baseUrl`) and goes through the guard in `guard.ts` before
 * anything is connected; the guard's rules and the fixed paths are in `client.ts`. Message text and model output are
 * never logged, and the proxy's request log carries the path only.
 */
import { connectionManifest } from "@openrhen/contracts";
import type { BoundConnection, OpCall } from "../../host/connection-api.js";
import { MODEL_ID, answer, fail, parseCompleteInput } from "../../host/model-complete.js";
import { OLLAMA_TIMEOUT_MS, completeWithOllama } from "./client.js";
import { ollamaPortsFromEnv, readOwnNetworks, type ResolveDeps } from "./guard.js";
import { pinnedHttpFetch } from "./pinned-fetch.js";

function manifest() {
  const found = connectionManifest("ollama");
  if (!found) throw new Error("The ollama manifest is missing from the registry.");
  return found;
}

export type OllamaSeams = ResolveDeps & {
  fetch?: (call: OpCall) => typeof fetch;
  timeoutMs?: number;
  /** Ports allowed besides none: 11434 plus `OUTBOUND_OLLAMA_EXTRA_PORTS`. */
  ports: ReadonlySet<number>;
  /** How many calls may wait behind the one in flight; default 2. */
  maxQueue?: number;
};

/**
 * One Ollama call in flight per proxy (a laptop runs one model at a time), with a short queue. A call that finds the
 * queue full is answered `rate_limited`; one that is cancelled while waiting leaves the queue.
 */
export function createLimiter(maxQueue: number) {
  let busy = false;
  const waiting: (() => void)[] = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else busy = false;
  };
  return {
    /** A release function, or null when the queue is full. Rejects if `signal` aborts while waiting. */
    async acquire(signal: AbortSignal): Promise<(() => void) | null> {
      if (!busy) {
        busy = true;
        return release;
      }
      if (waiting.length >= maxQueue) return null;
      await new Promise<void>((resolve, reject) => {
        const start = () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          const at = waiting.indexOf(start);
          if (at >= 0) waiting.splice(at, 1);
          reject(new Error("The Ollama call was cancelled while waiting."));
        };
        waiting.push(start);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      return release;
    }
  };
}

/** The connection with its seams open for tests: the own-subnet list, the ports and the transport. */
export function createOllamaConnection(seams: () => OllamaSeams): BoundConnection {
  return {
    manifest: manifest(),
    create: () => {
      const resolved = seams();
      const limiter = createLimiter(resolved.maxQueue ?? 2);
      const clock = resolved.timeoutMs ?? OLLAMA_TIMEOUT_MS;
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
              const startedAt = Date.now();
              const release = await limiter.acquire(call.signal);
              if (!release)
                return answer(
                  fail(
                    "rate_limited",
                    "Ollama is busy with another request and the waiting line is full. Mail understanding sends one request at a time; wait a minute and call again, and do not retry in a loop."
                  )
                );
              try {
                // Time spent waiting counts against the same clock, so the host's backstop is never reached first.
                const remaining = clock - (Date.now() - startedAt);
                if (remaining <= 0)
                  return answer(
                    fail(
                      "timeout",
                      "Ollama was busy with another request for the whole time allowed. Retry later; a model that is still loading can take minutes the first time."
                    )
                  );
                const result = await completeWithOllama(
                  { ...parsed.input, baseUrl: body.baseUrl, withDigest: body.withDigest === true },
                  {
                    ownNetworks: resolved.ownNetworks,
                    allowedPorts: resolved.ports,
                    fetch: resolved.fetch?.(call) ?? pinnedHttpFetch(),
                    signal: call.signal,
                    timeoutMs: remaining,
                    allowedMs: clock
                  }
                );
                return answer(result);
              } finally {
                release();
              }
            }
          }
        }
      };
    }
  };
}

// The proxy's own subnets are read when the host creates the connection, which is at start.
export const ollamaConnection: BoundConnection = createOllamaConnection(() => ({
  ownNetworks: readOwnNetworks(),
  // Throws at start when OUTBOUND_OLLAMA_EXTRA_PORTS is malformed, which marks the connection failed and logs why.
  ports: ollamaPortsFromEnv(process.env)
}));
