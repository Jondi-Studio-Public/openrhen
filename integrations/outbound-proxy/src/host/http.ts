import type { IncomingMessage, ServerResponse } from "node:http";

/** The credential value compose.yaml falls back to when nobody has set the real one yet. */
export const PLACEHOLDER_CREDENTIAL = "replace-before-lan-use";

export function envInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// Read per-request rather than cached at module load, so a test (or a `docker compose` env change
// picked up by a restart) sees the value it set. `envInt` itself is cheap enough that this costs
// nothing worth caching.
/**
 * Wall-clock ceiling for a non-streaming upstream call (a drop-in connection, Google Routes/Geocode, the
 * non-streaming OpenAI extraction, and the OpenAI reachability probe). Reset per request, not
 * per attempt — `fetchWithTransportRetry`'s one retry happens inside this same window.
 */
export const upstreamTimeoutMs = () => envInt("OUTBOUND_UPSTREAM_TIMEOUT_MS", 60_000);
/** For streaming ops: reset on every SSE chunk. Bounds how long an idle upstream can hold the socket open. */
export const streamIdleTimeoutMs = () => envInt("OUTBOUND_STREAM_IDLE_TIMEOUT_MS", 30_000);
/** For streaming ops: an absolute ceiling regardless of chunk activity, so a chatty-but-stuck stream still ends. */
export const streamMaxMs = () => envInt("OUTBOUND_STREAM_MAX_MS", 600_000);
/** Request bodies larger than this are refused before they are ever handed to a route. */
export const maxBodyBytes = () => envInt("OUTBOUND_MAX_BODY_BYTES", 8_388_608);

/** Binds an AbortSignal onto every fetch made through it, without threading a new parameter through each client. */
export function fetchWithSignal(signal: AbortSignal): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    fetch(input, { ...init, signal })) as typeof fetch;
}

/**
 * Runs one non-streaming upstream call under `timeoutMs`. On timeout it aborts `controller` (which
 * is also wired to the inbound request's own close/disconnect — see `handleRequest`) and, if nothing
 * has been written yet, answers 504. A plain client disconnect aborts the same way but answers
 * nothing — there is nobody left to read a response.
 */
export async function runUpstream<T>(
  response: ServerResponse,
  controller: AbortController,
  timeoutMs: number,
  task: () => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false }> {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return { ok: true, value: await task() };
  } catch (error) {
    if (timedOut) {
      if (!response.headersSent) json(response, 504, { error: "upstream_timeout" });
      return { ok: false };
    }
    if (controller.signal.aborted) return { ok: false };
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads and JSON-parses the request body, refusing anything over `maxBytes`. A declared
 * Content-Length over the cap is rejected before a single byte is read; an absent or lying
 * Content-Length is caught as bytes actually arrive, so a chunked or misreported body cannot
 * still buffer unbounded memory.
 */
export async function readBody(
  request: IncomingMessage,
  maxBytes: number
): Promise<{ value?: unknown; error?: "invalid_json" | "too_large" }> {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return { error: "too_large" };

  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += buffer.length;
    if (received > maxBytes) return { error: "too_large" };
    chunks.push(buffer);
  }
  try {
    return { value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { error: "invalid_json" };
  }
}

export function tooLarge(response: ServerResponse) {
  response.writeHead(413, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify({ error: "payload_too_large" }), () => response.destroy());
}

export function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}
