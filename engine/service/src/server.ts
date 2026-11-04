import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  PLAN_FORECAST_CONTRACT_VERSION,
  planForecastRequestSchema,
  planForecastResponseSchema
} from "@openrhen/contracts";
import { calculatePlanAndForecast, PLAN_FORECAST_ENGINE_VERSION } from "@openrhen/engine-core";

export interface ServiceConfig {
  token: string;
  maxPayloadBytes: number;
}

/**
 * Never rejects: a malformed or aborted request must not become an unhandled rejection, which
 * terminates the process. Any escaped error is logged, answered 500 if headers are still unsent, and
 * otherwise the connection is destroyed.
 */
export async function handleRequest(request: IncomingMessage, response: ServerResponse, config: ServiceConfig) {
  try {
    await route(request, response, config);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ level: "error", message: "Plan and Forecast Engine request failed", error: error instanceof Error ? error.message : "Unknown error" })}\n`
    );
    if (response.headersSent) response.destroy();
    else calculationFailed(response);
  }
}

async function route(request: IncomingMessage, response: ServerResponse, config: ServiceConfig) {
  // An unparseable target (for example "//") matches no route, so it falls through to the 404 below.
  let pathname = "";
  try {
    pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  } catch {
    // leave pathname empty
  }
  logWhenFinished(request, response, pathname);
  if (request.method === "GET" && pathname === "/health") return json(response, 200, { status: "ok" });
  if (request.method === "GET" && pathname === "/ready")
    return json(response, 200, {
      status: "ready",
      contractVersion: PLAN_FORECAST_CONTRACT_VERSION,
      engineVersion: PLAN_FORECAST_ENGINE_VERSION
    });
  if (request.method !== "POST" || pathname !== "/v1/plan-and-forecast")
    return json(response, 404, { error: { code: "not_found", message: "Route not found." } });
  if (!authorised(request.headers.authorization, config.token))
    return json(response, 401, { error: { code: "unauthorised", message: "A valid bearer token is required." } });
  const body = await readBody(request, config.maxPayloadBytes);
  if (body.tooLarge)
    return json(response, 413, {
      error: { code: "payload_too_large", message: "The planning request exceeded the configured limit." }
    });
  if (body.error)
    return json(response, 400, { error: { code: "invalid_json", message: "The request body must be valid JSON." } });
  const parsed = planForecastRequestSchema.safeParse(body.value);
  if (!parsed.success)
    return json(response, 400, {
      error: {
        code: "validation_failed",
        message: "The planning request failed validation.",
        issues: parsed.error.issues
      }
    });
  try {
    const result = planForecastResponseSchema.parse(calculatePlanAndForecast(parsed.data));
    return json(response, 200, result);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ level: "error", message: "Plan and forecast calculation failed", requestId: parsed.data.requestId, error: error instanceof Error ? error.message : "Unknown error" })}\n`
    );
    return calculationFailed(response);
  }
}

function calculationFailed(response: ServerResponse) {
  return json(response, 500, {
    error: { code: "calculation_failed", message: "The plan and forecast calculation failed." }
  });
}

/**
 * One line per request, written when the response is actually finished so the duration is the whole
 * request rather than the handler alone. The path is the route, never the query string, and no
 * header reaches the line — the authorization header is the only interesting one and it must not.
 *
 * `/ready` is the container healthcheck's target every five seconds; recording its successes would
 * bury the planning calls this log exists for, so a healthy probe stays silent and a failing one
 * does not. Suppressed while `NODE_ENV` is `test`, where the suite drives this handler directly.
 */
function logWhenFinished(request: IncomingMessage, response: ServerResponse, pathname: string) {
  if (process.env.NODE_ENV === "test") return;
  const startedAt = Date.now();
  response.on("finish", () => {
    const probe = pathname === "/ready" || pathname === "/health";
    if (probe && response.statusCode < 400) return;
    const level = response.statusCode >= 500 ? "error" : "info";
    const line = `${JSON.stringify({
      level,
      message: "Plan and Forecast Engine request",
      method: request.method ?? "UNKNOWN",
      path: pathname,
      status: response.statusCode,
      durationMs: Date.now() - startedAt
    })}\n`;
    if (level === "error") process.stderr.write(line);
    else process.stdout.write(line);
  });
}

function authorised(header: string | undefined, configuredToken: string) {
  if (!configuredToken || !header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(configuredToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readBody(
  request: IncomingMessage,
  maximum: number
): Promise<{ value?: unknown; error?: true; tooLarge?: true }> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of request) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += value.length;
      if (size > maximum) return { tooLarge: true };
      chunks.push(value);
    }
  } catch {
    return { error: true };
  }
  try {
    return { value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { error: true };
  }
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}
