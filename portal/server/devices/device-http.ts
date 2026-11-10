import { requestAgent } from "@/server/agent-actor";
import { createFailureThrottle, remoteAddress, sharedFailureThrottle } from "@/server/agent-token-throttle";
import { sqlPool, type PoolSql } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/** Shared framing for the device sign-in routes. */

/** An agent identity (even a self-declared name) is never the owner here. */
export const agentRefusal = () =>
  requestAgent() === null ? null : Response.json({ error: "Devices are paired by the owner." }, { status: 403 });

/** The pool, or the 503 an install without PostgreSQL gets. */
export function devicePool(): PoolSql | Response {
  const url = databaseUrl();
  return url ? sqlPool(url) : Response.json({ error: "Device sign-in requires PostgreSQL." }, { status: 503 });
}

export const tooManyAttempts = (seconds: number) =>
  Response.json(
    { error: "Too many unrecognised attempts; wait before trying again." },
    { status: 429, headers: { "retry-after": String(seconds) } }
  );

/** The address a request came from, as the failure throttle and `last_used_from` read it. */
export const addressOf = (request: Request): string => remoteAddress(request.headers);

/** Asking for a device code is open to anyone who can reach the portal, so each address gets a few a minute. */
export const codeStartThrottle = createFailureThrottle(5, 60_000);

/** Counts a bad guess against the shared throttle, or answers 429 if the address is already over it. */
export function guard(request: Request): Response | null {
  const wait = sharedFailureThrottle.retryAfter(addressOf(request));
  return wait > 0 ? tooManyAttempts(wait) : null;
}

export const fail = (request: Request): void => sharedFailureThrottle.fail(addressOf(request));
