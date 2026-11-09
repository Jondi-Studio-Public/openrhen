import type { IncomingMessage, ServerResponse } from "node:http";
import { capabilityIdSchema, type CapabilityFailure, type CapabilityId } from "@openrhen/contracts";
import type { ConnectionOp, OpCall } from "./connection-api.js";
import { connectionHost } from "./connection-host.js";
import {
  fetchWithSignal,
  json,
  maxBodyBytes,
  readBody,
  runUpstream,
  streamIdleTimeoutMs,
  streamMaxMs,
  tooLarge,
  upstreamTimeoutMs
} from "./http.js";
import { takeAiRateSlot, takeEmbeddingRateSlot, takeHostedRateSlot, takeLocalRateSlot } from "./rate.js";

type Prepared = { ok: true; op: ConnectionOp } | { ok: false; status: number; body: CapabilityFailure };

function failure(status: number, error: string, reason?: CapabilityFailure["reason"]): Prepared {
  return { ok: false, status, body: reason ? { error, reason } : { error } };
}

/** Finds the op and takes its rate slot. The slot is taken before the body is read, as the pre-capability routes did. */
function prepare(capability: string, id: string, opId: string): Prepared {
  const loaded = connectionHost().find((candidate) => candidate.bound.manifest.id === id);
  if (!loaded) return failure(404, `No connection named ${id}.`, "unknown_connection");
  // Own-property lookups only: `__proto__` and `constructor` pass the path regex.
  const table = capabilityIdSchema.safeParse(capability).success
    ? loaded.impl?.[capability as CapabilityId]
    : undefined;
  const op = table && Object.hasOwn(table, opId) ? (table as Record<string, ConnectionOp>)[opId] : undefined;
  if (!op) {
    if (loaded.failed) return failure(503, `${loaded.bound.manifest.label} is not available.`, "not_ready");
    return failure(
      404,
      `${loaded.bound.manifest.label} does not support ${capability}.${opId}.`,
      "unsupported_operation"
    );
  }
  if (op.rate === "ai" && !takeAiRateSlot()) return failure(429, "Too many AI requests; try again shortly.");
  if (op.rate === "embedding" && !takeEmbeddingRateSlot())
    return failure(429, "Too many embedding requests; try again shortly.");
  if (op.rate === "local" && !takeLocalRateSlot())
    return failure(429, "Too many local-model requests; try again shortly.");
  if (op.rate === "hosted" && !takeHostedRateSlot())
    return failure(429, "Too many hosted-model requests; try again shortly.");
  return { ok: true, op };
}

async function execute(
  op: ConnectionOp,
  body: unknown,
  pathname: string,
  response: ServerResponse,
  controller: AbortController
) {
  const call: OpCall = {
    body,
    fetch: fetchWithSignal(controller.signal),
    signal: controller.signal,
    env: process.env,
    pathname
  };

  if (op.kind !== "json" && op.kind !== "stream")
    return json(response, 500, { error: "The connection op has an unknown kind." });

  if (op.kind === "json") {
    const outcome = await runUpstream(response, controller, op.timeoutMs ?? upstreamTimeoutMs(), () => op.run(call));
    if (!outcome.ok) return;
    return json(response, outcome.value.status, outcome.value.body);
  }

  // Stream op: two clocks, as the original /ai/stream route had. The idle timer resets on every chunk
  // (and runs from the start while waiting for the first); the max timer is absolute. Either aborts
  // the upstream fetch. With headers already on the wire the socket is torn down rather than
  // answered, since a client mid-stream cannot parse a JSON body appended after raw SSE bytes.
  let timedOut = false;
  const markTimedOut = () => {
    timedOut = true;
    controller.abort();
  };
  let idleTimer = setTimeout(markTimedOut, streamIdleTimeoutMs());
  const maxTimer = setTimeout(markTimedOut, streamMaxMs());
  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(markTimedOut, streamIdleTimeoutMs());
  };
  const clearStreamTimers = () => {
    clearTimeout(idleTimer);
    clearTimeout(maxTimer);
  };

  try {
    const result = await op.run(call);
    if (!(result instanceof Response)) {
      clearStreamTimers();
      return json(response, result.status, result.body);
    }
    if (!result.ok || !result.body) {
      clearStreamTimers();
      // Keep the upstream's own message, as the old /ai/stream did, then release the connection.
      const payload = (await result.json().catch(() => null)) as { error?: { message?: string } } | null;
      await result.body?.cancel().catch(() => {});
      return json(response, 502, { error: payload?.error?.message ?? `Streaming failed (${result.status}).` });
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    for await (const chunk of result.body) {
      resetIdleTimer();
      response.write(chunk);
    }
    clearStreamTimers();
    return response.end();
  } catch (error) {
    clearStreamTimers();
    if (timedOut) {
      if (!response.headersSent) return json(response, 504, { error: "upstream_timeout" });
      response.destroy();
      return;
    }
    if (controller.signal.aborted) return; // the client disconnected; nobody is left to answer
    if (response.headersSent) return response.end();
    return json(response, 502, { error: error instanceof Error ? error.message : "The streaming call failed." });
  }
}

/** Runs one already-parsed call: look up, rate-limit, execute. */
export async function dispatch(
  capability: string,
  id: string,
  op: string,
  body: unknown,
  request: IncomingMessage,
  response: ServerResponse,
  controller: AbortController
) {
  const prepared = prepare(capability, id, op);
  if (!prepared.ok) return json(response, prepared.status, prepared.body);
  return execute(prepared.op, body, new URL(request.url ?? "/", "http://localhost").pathname, response, controller);
}

/** Reads the JSON body, answering 400 or 413. Returns undefined once answered. */
async function readJsonBody(
  request: IncomingMessage,
  response: ServerResponse
): Promise<{ value: unknown } | undefined> {
  const body = await readBody(request, maxBodyBytes());
  if (body.error === "too_large") {
    tooLarge(response);
    return undefined;
  }
  if (body.error) {
    json(response, 400, { error: "The request body must be valid JSON." });
    return undefined;
  }
  return { value: body.value };
}

/** `POST /capabilities/<capability>/<id>/<op>`. Returns false when the path is not a capability route. */
export async function routeCapability(
  request: IncomingMessage,
  response: ServerResponse,
  controller: AbortController,
  pathname: string
): Promise<boolean> {
  const match = /^\/capabilities\/([a-z_]+)\/([a-z0-9_]+)\/([a-z_]+)$/.exec(pathname);
  if (!match || request.method !== "POST") {
    json(response, 404, { error: "Route not found." });
    return true;
  }
  const [, capability, id, opId] = match as unknown as [string, string, string, string];
  const prepared = prepare(capability, id, opId);
  if (!prepared.ok) {
    json(response, prepared.status, prepared.body);
    return true;
  }
  const body = await readJsonBody(request, response);
  if (body) await execute(prepared.op, body.value, pathname, response, controller);
  return true;
}
