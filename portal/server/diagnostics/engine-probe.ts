import { runtimeEnv } from "@/server/runtime-env";

const DEFAULT_TIMEOUT_MS = 5_000;

export interface EngineProbe {
  reachable: boolean;
  configured: boolean;
  latencyMs?: number;
  status?: string;
  contractVersion?: string | null;
  engineVersion?: string | null;
  detail?: string;
}

/**
 * Liveness only. The portal never asks the engine to calculate — planning work still goes through
 * the job queue and the worker. This exists so a stopped engine is visible rather than showing up
 * as an unexplained stale plan.
 *
 * Shared by the health route and issue-snapshot capture so both report the engine identically.
 */
export async function probeEngine(): Promise<EngineProbe> {
  const configuration = runtimeEnv();
  const url = configuration.PLAN_FORECAST_SERVICE_URL;
  if (!url)
    return {
      reachable: false,
      configured: false,
      detail: "PLAN_FORECAST_SERVICE_URL is not set for the portal runtime."
    };
  const timeoutMs = positiveInteger(configuration.PLAN_FORECAST_REQUEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    // `/ready` is unauthenticated by design, so no bearer token is sent.
    const response = await fetch(`${url.replace(/\/$/, "")}/ready`, { signal: controller.signal, cache: "no-store" });
    const latencyMs = Math.round(performance.now() - started);
    if (!response.ok)
      return { reachable: false, configured: true, latencyMs, detail: `The engine answered with ${response.status}.` };
    const body = (await response.json().catch(() => null)) as {
      status?: string;
      contractVersion?: string;
      engineVersion?: string;
    } | null;
    return {
      reachable: true,
      configured: true,
      latencyMs,
      status: body?.status ?? "unknown",
      contractVersion: body?.contractVersion ?? null,
      engineVersion: body?.engineVersion ?? null
    };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - started);
    const aborted = error instanceof Error && error.name === "AbortError";
    // Some runtimes report a refused connection as an opaque "internal error; reference = ..."
    // string, which tells the reader nothing. Drop that and say what actually happened instead.
    const raw = error instanceof Error ? error.message : "";
    const useful = raw && !/internal error|reference\s*=/i.test(raw) ? ` ${raw}` : "";
    const detail = (
      aborted
        ? `No answer from the engine at ${url} within ${timeoutMs} ms.`
        : `No answer from the engine at ${url}.${useful}`
    ).slice(0, 240);
    return { reachable: false, configured: true, latencyMs, detail };
  } finally {
    clearTimeout(timeout);
  }
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
