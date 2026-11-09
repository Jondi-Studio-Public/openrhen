import { createHash, timingSafeEqual } from "node:crypto";
import {
  OWNER_AUTH_MODES,
  OWNER_COOKIE,
  OWNER_HEADER,
  DEVICE_HEADER,
  deviceRoute,
  OWNER_SESSION_DAYS,
  ownerAuthExemption,
  rateLimitMessage,
  scopesForRoute,
  WORKER_HEADER,
  workerRoute,
  type OwnerAuthMode
} from "@openrhen/contracts";
import "./drop-ins";
import { remoteAddress, sharedFailureThrottle, type FailureThrottle } from "./agent-token-throttle";
import type { AgentPrincipal } from "./agent-tokens";
import type { StoredOwnerCredential } from "./owner-credential-store";

/**
 * Owner authentication (the design notes, decision D2). The owner proves who they are
 * with an enrolled browser's cookie or with an owner token in `X-OpenRhen-Owner`. `OPENRHEN_OWNER_AUTH`:
 * `off` changes nothing (a caller with no identity is the owner); `shadow` logs what `require` would refuse and
 * changes nothing; `require` refuses a write, and a read of the API, that carries no owner credential and no
 * agent token.
 */

export const OWNER_HEADER_NAME = OWNER_HEADER.toLowerCase();
const WORKER_HEADER_NAME = WORKER_HEADER.toLowerCase();
const DEVICE_HEADER_NAME = DEVICE_HEADER.toLowerCase();

// Read straight from the environment for the same reason `agent-tokens.ts` does: `withRoute` runs for every route.
export function ownerAuthMode(): OwnerAuthMode {
  const raw = process.env.OPENRHEN_OWNER_AUTH?.trim().toLowerCase();
  return (OWNER_AUTH_MODES as readonly string[]).includes(raw ?? "") ? (raw as OwnerAuthMode) : "off";
}

/** `OWNER_RECOVERY_TOKEN`: the sha256 (hex) of a token you keep in your secrets manager, accepted only at the enroll route. */
export function recoveryHash(): string | undefined {
  const raw = process.env.OWNER_RECOVERY_TOKEN?.trim().toLowerCase();
  return raw && /^[0-9a-f]{64}$/.test(raw) ? raw : undefined;
}

const sha = (value: string) => createHash("sha256").update(value).digest();

/** Whether `secret` is the recovery token. Constant time; false when none is configured. */
export function matchesRecovery(secret: string, expectedHex: string | undefined = recoveryHash()): boolean {
  if (!expectedHex) return false;
  return timingSafeEqual(sha(secret), Buffer.from(expectedHex, "hex"));
}

/** `WORKER_TOKEN_HASH`: the sha256 (hex) of the worker's token, accepted only on the routes the worker calls. */
export function workerTokenHash(): string | undefined {
  const raw = process.env.WORKER_TOKEN_HASH?.trim().toLowerCase();
  return raw && /^[0-9a-f]{64}$/.test(raw) ? raw : undefined;
}

/** Whether `secret` is the worker token. Constant time; false when none is configured. */
export function matchesWorker(secret: string, expectedHex: string | undefined = workerTokenHash()): boolean {
  if (!expectedHex) return false;
  return timingSafeEqual(sha(secret), Buffer.from(expectedHex, "hex"));
}

/** `DEVICE_TOKEN_HASH`: the sha256 (hex) of the handheld's token, accepted only on the two device routes. */
export function deviceTokenHash(): string | undefined {
  const raw = process.env.DEVICE_TOKEN_HASH?.trim().toLowerCase();
  return raw && /^[0-9a-f]{64}$/.test(raw) ? raw : undefined;
}

/** Whether `secret` is the device token. Constant time; false when none is configured. */
export function matchesDevice(secret: string, expectedHex: string | undefined = deviceTokenHash()): boolean {
  if (!expectedHex) return false;
  return timingSafeEqual(sha(secret), Buffer.from(expectedHex, "hex"));
}

export interface OwnerDeps {
  lookup?: (hash: string) => Promise<StoredOwnerCredential | null>;
  /** Records a use and slides a browser session; resolves true when the session slid (so its cookie is re-sent). */
  touch?: (id: string, kind: StoredOwnerCredential["kind"]) => Promise<boolean>;
  throttle?: FailureThrottle;
  now?: () => Date;
  /**
   * Told when a device route turned a caller away for want of a device token (`device-invalid`: a token that is not
   * recognised; `device-anonymous`: none at all), so a handheld that keeps being refused is seen and not just quiet.
   * Not told for a throttled address or under `shadow`. Its failure never changes the refusal. The default writes a
   * `device:handheld` run row.
   */
  onDeviceRefused?: (reason: "device-invalid" | "device-anonymous") => void;
}

async function databaseLookup(hash: string): Promise<StoredOwnerCredential | null> {
  const [{ databaseUrl }, { sqlPool }, store] = await Promise.all([
    import("./runtime-env"),
    import("./persistence/postgres/sql-pool"),
    import("./owner-credential-store")
  ]);
  const url = databaseUrl();
  return url ? store.findOwnerCredentialByHash(sqlPool(url), hash) : null;
}

async function databaseTouch(id: string, kind: StoredOwnerCredential["kind"]): Promise<boolean> {
  try {
    const [{ databaseUrl }, { sqlPool }, store] = await Promise.all([
      import("./runtime-env"),
      import("./persistence/postgres/sql-pool"),
      import("./owner-credential-store")
    ]);
    const url = databaseUrl();
    return url ? await store.touchOwnerCredential(sqlPool(url), id, kind) : false;
  } catch {
    return false; // a missed `last_used_at` must never fail the request it describes
  }
}

/** Last time each credential was touched in this process, so the database sees a use at most once a minute. */
const lastTouched = new Map<string, number>();

export type OwnerCheck =
  | { kind: "none" }
  | { kind: "ok"; id: string; credential: StoredOwnerCredential["kind"]; via: "cookie" | "header"; slid: boolean }
  | { kind: "invalid"; status: 401 | 429 | 503; error: string; retryAfter?: number; clearCookie?: true };

export function cookieValue(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || undefined;
  }
  return undefined;
}

/**
 * Looks for an owner credential: the header (an owner token) first, else the cookie (an enrolled browser). An
 * unknown secret counts against the shared failure throttle; a revoked or expired one does not (it is a known
 * hash, not a guess). Nothing here throws for a bad credential.
 */
export async function verifyOwnerCredential(request: Request, deps: OwnerDeps = {}): Promise<OwnerCheck> {
  const header = request.headers.get(OWNER_HEADER_NAME)?.trim();
  const cookie = cookieValue(request, OWNER_COOKIE);
  const presented = header || cookie;
  if (!presented) return { kind: "none" };
  const via = header ? "header" : "cookie";
  const throttle = deps.throttle ?? sharedFailureThrottle;
  const address = remoteAddress(request.headers);
  // Only a header is a guess. A stale cookie (after a restore, say) is the owner's own browser: it is answered as
  // unauthenticated and cleared, and never counts against the throttle that guards the recovery token.
  const wait = via === "header" ? throttle.retryAfter(address) : 0;
  if (wait > 0)
    return {
      kind: "invalid",
      status: 429,
      error: rateLimitMessage(wait, "unrecognised credentials"),
      retryAfter: wait
    };
  const digest = sha(presented);
  const stale = via === "cookie" ? { clearCookie: true as const } : {};
  let stored: StoredOwnerCredential | null;
  try {
    stored = await (deps.lookup ?? databaseLookup)(digest.toString("hex"));
  } catch {
    return { kind: "invalid", status: 503, error: "Owner credentials could not be checked just now; try again." };
  }
  const expected = via === "header" ? "token" : "browser";
  if (
    !stored ||
    stored.kind !== expected ||
    stored.secretHash.length !== 64 ||
    !timingSafeEqual(digest, Buffer.from(stored.secretHash, "hex"))
  ) {
    if (via === "header") throttle.fail(address);
    return { kind: "invalid", status: 401, error: "The owner credential is not recognised.", ...stale };
  }
  const now = (deps.now ?? (() => new Date()))();
  if (stored.revokedAt) return { kind: "invalid", status: 401, error: "The owner credential was revoked.", ...stale };
  if (stored.expiresAt && stored.expiresAt.getTime() <= now.getTime())
    return { kind: "invalid", status: 401, error: "The owner credential has expired.", ...stale };
  let slid = false;
  const last = lastTouched.get(stored.id) ?? 0;
  if (now.getTime() - last >= 60_000) {
    lastTouched.set(stored.id, now.getTime());
    if (lastTouched.size > 500) lastTouched.clear();
    slid = await (deps.touch ?? databaseTouch)(stored.id, stored.kind);
  }
  return { kind: "ok", id: stored.id, credential: stored.kind, via, slid };
}

/** The browser cookie. `Secure` when the request came over https (directly or through the proxy). */
export function ownerCookie(request: Request, secret: string | null): string {
  const https =
    request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https" ||
    new URL(request.url).protocol === "https:";
  const maxAge = secret === null ? 0 : OWNER_SESSION_DAYS * 86_400;
  return `${OWNER_COOKIE}=${secret ?? ""}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${https ? "; Secure" : ""}`;
}

/**
 * A cookie-authenticated write must come from this origin: `Origin` is present and its host is the request's
 * `Host`. `SameSite=Strict` alone does not cover a sibling subdomain, which is same-site.
 */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host") ?? new URL(request.url).host;
  if (!origin) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

const READ = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Requests this process built for itself on behalf of an owner who was already authenticated (the in-process CLI
 * runner, `mcp-cli-runner.ts`, behind an owner-only route). Keyed by the `Request` object, so only code in this
 * process can add to it; a request off the wire is never in it, whatever headers it carries.
 */
const vouchedOwner = new WeakSet<Request>();

/** Marks an in-process request as made by the owner, so `ownerGate` lets it through under every mode. Callers must have authenticated the owner themselves. */
export function vouchOwnerRequest(request: Request): void {
  vouchedOwner.add(request);
}

export interface OwnerOutcome {
  refusal?: Response;
  /** Set when the device token let this request in (a device route, no owner credential). */
  device?: true;
  /** Set when a valid owner credential made this request: the person, whatever name it also declared. */
  owner?: { id: string; credential: StoredOwnerCredential["kind"]; via: "cookie" | "header" };
  /** The request carried a cookie that is no longer valid: clear it. */
  clearCookie?: true;
  /** The browser session slid: send its cookie again so the browser's 30 days start over. */
  slid?: true;
  /** Under `shadow`: what `require` would have answered. Nothing was refused. */
  wouldRefuse?: { status: number; reason: string; worker?: true; device?: true };
}

const refuse = (status: number, error: string, headers?: Record<string, string>) =>
  Response.json({ error }, { status, ...(headers ? { headers } : {}) });

const DEVICE_REFUSALS = new Set(["device-invalid", "device-anonymous"]);

/** Reports a refused device route to the hook, or to the run log when none is given. Fire and forget: it cannot change the answer. */
function tellDeviceRefused(refusal: Response, hook: OwnerDeps["onDeviceRefused"]): void {
  const reason = refusal.headers.get("x-owner-reason");
  if (reason === null || !DEVICE_REFUSALS.has(reason)) return;
  const typed = reason as "device-invalid" | "device-anonymous";
  try {
    if (hook) hook(typed);
    else
      void import("./device/device-poll-log").then(
        ({ recordDevicePoll }) => recordDevicePoll({ status: "failed", reason: typed }),
        () => undefined
      );
  } catch {
    // A hook that fails must not turn a refusal into an error.
  }
}

/**
 * The outcome `ownerGate` reached for a request, kept for the handler that serves it. Keyed by the `Request`, so
 * only this process can set it: a handler asks `ownerOutcomeOf(request)`, which is empty for a request nobody gated.
 */
const outcomes = new WeakMap<Request, OwnerOutcome>();

/** Remembers the outcome for this request (`withRoute` calls it once the gate has let the request through). */
export function noteOwnerOutcome(request: Request, outcome: OwnerOutcome): void {
  outcomes.set(request, outcome);
}

/** What `ownerGate` decided for this request, for a handler that needs to know how the caller got in. */
export function ownerOutcomeOf(request: Request): OwnerOutcome | undefined {
  return outcomes.get(request);
}

/**
 * The owner-auth decision for one request, after agent tokens were resolved. `agent` is the principal a valid
 * agent token produced (database or environment); a header-only name is not one, and counts as anonymous here.
 */
export async function ownerGate(input: {
  request: Request;
  route: string;
  agent: AgentPrincipal | undefined;
  mode?: OwnerAuthMode;
  deps?: OwnerDeps;
}): Promise<OwnerOutcome> {
  if (vouchedOwner.has(input.request) && !input.agent)
    return { owner: { id: "in-process", credential: "token", via: "header" } };
  const mode = input.mode ?? ownerAuthMode();
  if (mode === "off") return {};
  const { request, route, agent } = input;
  const method = request.method.toUpperCase();
  const write = !READ.has(method);
  const outcome = await decide();
  if (mode === "require" && outcome.refusal) tellDeviceRefused(outcome.refusal, input.deps?.onDeviceRefused);
  if (mode === "shadow") {
    // Behave as off: only report what would have been refused.
    return outcome.refusal
      ? {
          wouldRefuse: {
            status: outcome.refusal.status,
            reason: outcome.refusal.headers.get("x-owner-reason") ?? "refused",
            ...(workerRoute(method, route) ? { worker: true as const } : {}),
            ...(deviceRoute(method, route) ? { device: true as const } : {})
          }
        }
      : {};
  }
  return outcome;

  async function decide(): Promise<OwnerOutcome> {
    // A worker route takes the worker token and a device route the device token, each on its own route set only;
    // without one the owner credential is the way in.
    const kind = workerRoute(method, route) ? "worker" : deviceRoute(method, route) ? "device" : undefined;
    const presented =
      !agent && kind
        ? request.headers.get(kind === "worker" ? WORKER_HEADER_NAME : DEVICE_HEADER_NAME)?.trim()
        : undefined;
    if (kind && presented) {
      const throttle = input.deps?.throttle ?? sharedFailureThrottle;
      const address = remoteAddress(request.headers);
      const wait = throttle.retryAfter(address);
      if (wait > 0)
        return {
          refusal: refuse(429, rateLimitMessage(wait, "unrecognised credentials"), {
            "retry-after": String(wait),
            "x-owner-reason": `${kind}-throttled`
          })
        };
      if (kind === "worker" ? matchesWorker(presented) : matchesDevice(presented))
        return kind === "device" ? { device: true } : {};
      throttle.fail(address);
      return { refusal: refuse(401, `The ${kind} token is not recognised.`, { "x-owner-reason": `${kind}-invalid` }) };
    }
    // An agent token names the caller; an owner header sent beside it does not turn the agent into the owner.
    const check = agent ? ({ kind: "none" } as OwnerCheck) : await verifyOwnerCredential(request, input.deps);
    if (check.kind === "ok") {
      if (write && check.via === "cookie" && !sameOrigin(request))
        return { refusal: refuse(403, "A browser session may only write from this site (Origin must match Host).") };
      return {
        owner: { id: check.id, credential: check.credential, via: check.via },
        ...(check.slid && check.via === "cookie" ? { slid: true as const } : {})
      };
    }
    if (check.kind === "invalid" && check.status !== 401)
      return {
        refusal: refuse(
          check.status,
          check.error,
          check.retryAfter ? { "retry-after": String(check.retryAfter) } : undefined
        )
      };
    const clear = check.kind === "invalid" && check.clearCookie ? { clearCookie: true as const } : {};
    if (agent) {
      // A legacy environment token is not scope-checked by the wrapper, so keep it off the owner's own routes here.
      if (
        agent.source === "env" &&
        scopesForRoute(method, route).kind === "refused" &&
        !ownerAuthExemption(method, route)
      ) {
        const decision = scopesForRoute(method, route);
        if (decision.kind === "refused" && decision.reason === "owner-only")
          return { refusal: refuse(403, decision.message) };
      }
      return {};
    }
    if (ownerAuthExemption(method, route)) return clear;
    if (!write && scopesForRoute(method, route).kind === "public") return clear;
    const why = check.kind === "invalid" ? check.error : "An owner credential is required.";
    const hint = write
      ? "send X-OpenRhen-Owner, or sign this browser in"
      : "sign this browser in, or send X-OpenRhen-Owner";
    // A cookie that was sent but no longer works is a lapsed sign-in (30 days unused, revoked or restored over), not a new browser.
    const reason =
      check.kind === "invalid" && check.clearCookie
        ? "cookie-expired"
        : kind
          ? `${kind}-anonymous`
          : write
            ? "write-anonymous"
            : "read-anonymous";
    return {
      refusal: refuse(401, `${why} (${hint}${kind ? `, or the ${kind} token` : ""}.)`, {
        "x-owner-reason": reason
      }),
      ...clear
    };
  }
}

/**
 * The secret a caller offers to enrol a browser when it has no credential yet: a live owner token, or the
 * recovery token. A wrong guess counts against the shared throttle.
 */
export async function verifyEnrollSecret(
  request: Request,
  secret: string,
  deps: OwnerDeps = {}
): Promise<"ok" | "bad" | "throttled"> {
  const throttle = deps.throttle ?? sharedFailureThrottle;
  const address = remoteAddress(request.headers);
  if (throttle.retryAfter(address) > 0) return "throttled";
  if (matchesRecovery(secret)) return "ok";
  try {
    const stored = await (deps.lookup ?? databaseLookup)(sha(secret).toString("hex"));
    const now = (deps.now ?? (() => new Date()))();
    if (stored && stored.kind === "token" && !stored.revokedAt && (!stored.expiresAt || stored.expiresAt > now))
      return "ok";
  } catch {
    return "bad";
  }
  throttle.fail(address);
  return "bad";
}
