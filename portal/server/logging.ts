import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { AGENT_HEADER, parseAgentHeader, parseClaimHeaders, runWithActor } from "@/server/agent-actor";
import { noteAgentCall } from "@/server/agent-activity";
import { enforceAgentRequest } from "@/server/agent-enforcement";
import { reentryGate } from "@/server/pulse/reentry-gate";
import { identifyRequest } from "@/server/agent-tokens";
import { cookieValue, noteOwnerOutcome, ownerCookie, ownerGate } from "@/server/owner-auth";
import { OWNER_COOKIE, type AgentCall } from "@openrhen/contracts";
import { withServerCommit } from "@/server/build-commit";
import {
  CommandConflictError,
  CommandIdReusedError,
  CommittedReadFailedError,
  ForbiddenCommandError,
  InvalidCommandError,
  NotFoundCommandError
} from "@/server/persistence/postgres/command-errors";
import { portalHostAllowed } from "@/server/security/allowed-hosts";

/**
 * The portal's single log boundary.
 *
 * Route handlers used to return `error.message` straight to the browser and record nothing, so a
 * production failure existed only in whichever tab happened to hit it. Every route now runs through
 * `withRoute`: one JSON line per request, the failing stack kept server-side, and a 500 body that
 * says nothing about the internals.
 *
 * The line shape matches the Plan and Forecast Worker's (`{"level":"info","message":…}`) so that
 * `docker compose logs` reads the same across every service in the stack.
 *
 * One line per request rather than errors-only: this is a single-household portal whose whole day
 * is a few hundred requests, so the full trace costs nothing and answers "was the request even
 * received?" — the question an errors-only log cannot.
 *
 * Nothing here may accept a request body, a header value, or a connection string into a log line (the agent
 * header and token are read only to name the request's actor, and are never logged). The only caller-supplied
 * value that reaches a line is the command discriminator, which is a closed enum in the contracts.
 *
 * `POST /mcp` adds the fields of `McpLogFields` through `setMcp`, and they obey the same rule. Each is a member of a
 * closed set the server owns or a number the server computed: the manifest tool name (else `"unknown"`, never the
 * caller's string), the method (`initialize`, `ping`, `tools/list`, `tools/call`, `notification`, else `"other"`),
 * the outcome, the closed agent error code or a JSON-RPC code number (else `"other"`), byte lengths, and `idTag`, the
 * first 8 hex of a per-process salted HMAC of a caller-given command id. No argument, answer, id or header value is
 * ever written, only sizes and those tags.
 */

export type LogLevel = "info" | "error";

/** What a `POST /mcp` request may record about its call: closed sets and numbers only (see the file comment). */
export interface McpLogFields {
  mcpMethod?: "initialize" | "ping" | "tools/list" | "tools/call" | "notification" | "other" | undefined;
  /** A manifest tool name, or `"unknown"`. */
  mcpTool?: string | undefined;
  mcpOutcome?: "ok" | "tool_error" | "protocol_error" | undefined;
  /** A closed agent error code, `"other"`, or a JSON-RPC error code. Not `errorCode`, which is the SQLSTATE field. */
  toolErrorCode?: string | number | undefined;
  mcpRetryable?: boolean | undefined;
  /** Byte length of the JSON `arguments`. */
  argBytes?: number | undefined;
  /** Byte length of the serialized answer body. */
  resultBytes?: number | undefined;
  /** First 8 hex of a salted HMAC of the caller's command id; same-process repeats only. */
  idTag?: string | undefined;
}

export interface RequestLog {
  /**
   * Records which command this request carried. Callers pass the contract's `type` discriminator —
   * never an identifier, a note, or any other body field.
   */
  setCommandType(value: string): void;
  /**
   * Records the cause behind a failure the handler chose to answer itself. A route that turns a
   * fault into its own 4xx/5xx body still owes the operator the reason, and this is how it keeps
   * that reason server-side without putting the internals in the response.
   */
  setError(error: unknown): void;
  /** Records the MCP call fields. Merges with earlier calls; an `undefined` value is dropped. */
  setMcp(fields: McpLogFields): void;
}

export interface RouteLogOptions {
  /**
   * Marks a liveness probe: a healthy answer is not recorded, only a failing one.
   *
   * The container healthcheck polls `/api/health/database` every ten seconds, so logging its
   * successes would put roughly nine thousand lines a day into the log — swamping the handful of
   * real requests this portal serves and burying the failure someone is actually looking for. A
   * probe that starts failing still writes a line, which is the only thing its log was ever for.
   */
  probe?: boolean;
}

interface RequestLine extends McpLogFields {
  route: string;
  method: string;
  status: number;
  durationMs: number;
  commandType?: string;
  errorClass?: string;
  errorCode?: string;
  errorMessage?: string;
  stack?: string;
}

const CONNECTION_STRING = /postgres(?:ql)?:\/\/[^@\s/]+@/gi;
const BEARER = /bearer\s+\S+/gi;

/**
 * `key=value`, `key: value`, `"key":"value"`, `'key': 'value'` and escaped JSON (`\"key\":\"value\"`) for
 * the usual secret key names, also as the tail of a longer name (`refresh_token`, `client_secret`,
 * `accessToken`, `x-api-key`). The key is the only anchor and every alternative is a literal, so the scan
 * is linear in the input. A quoted value ends at its closing quote (or the end of a truncated message); a
 * bare one at whitespace, a quote, `,` `;` `&` or `}`. A known auth scheme word before the value goes with it,
 * so `Authorization: Token x` loses `Token x`; any other following word is left as the message's text.
 */
const ASSIGNED_SECRET =
  /(token|secret|passw(?:or)?d|pwd|api[_-]?key|private[_-]?key|credentials?|authorization)(\\?["']?)(\s*[=:]\s*)(?:(?:basic|bearer|token|digest|negotiate|hoba|mutual|aws4-hmac-sha256)\s+)?("(?:[^"\\]|\\.)*"?|'[^']*'?|\\"[^"]*"?|[^\s"',;&}]+)/gi;

/** A cookie header's value runs to the end of the line, since `;` separates its cookies, not the header. */
const COOKIE = /(cookie)(\\?["']?)(\s*[=:]\s*)("(?:[^"\\]|\\.)*"?|[^\r\n"']+)/gi;

const masked = (secret: string) =>
  secret.startsWith('"') ? '"***"' : secret.startsWith("'") ? "'***'" : secret.startsWith('\\"') ? '\\"***\\"' : "***";

/**
 * Strips the credentials that reach an error message by accident: `DATABASE_URL` arrives inside
 * `postgres` connection errors, and bearer tokens arrive inside fetch failures from the sidecars.
 * This is the same rule the database health route already applies, in one place instead of two.
 */
export function redact(value: string) {
  return value
    .replace(CONNECTION_STRING, "postgresql://***@")
    .replace(BEARER, "Bearer ***")
    .replace(
      ASSIGNED_SECRET,
      (_match, key: string, closingQuote: string, separator: string, secret: string) =>
        `${key}${closingQuote}${separator}${masked(secret)}`
    )
    .replace(
      COOKIE,
      (_match, key: string, closingQuote: string, separator: string, secret: string) =>
        `${key}${closingQuote}${separator}${masked(secret)}`
    );
}

/**
 * A Postgres constraint or input-format failure that escaped a command's own checks. These are almost
 * always the caller's fault (a reference to a record that is not there, a value the column refuses), so
 * they answer 4xx rather than a bare 500. The message names no table, constraint or value: the driver's
 * own text and `detail` carry those, and they stay in the server log only. It does name the field (the
 * column's agent-facing camelCase name, which is a field of the save, never a value) when the driver
 * reports one, says nothing was changed, and ends in a call an agent can send as it stands.
 */
const DATABASE_REFUSALS: Record<string, { status: 400 | 409; level: LogLevel }> = {
  "23503": { status: 400, level: "info" },
  "23505": { status: 409, level: "info" },
  // A CHECK or NOT NULL failure is as likely a command that forgot a column as a bad request, so it
  // still answers 400 but logs as an error.
  "23514": { status: 400, level: "error" },
  "23502": { status: 400, level: "error" },
  "22P02": { status: 400, level: "info" }
};

const NOTHING_CHANGED = "Nothing was changed.";
const RETRY_TAIL = "then repeat the save with a NEW command-id. If it fails again, tell the owner.";
const READ_TAIL = `Read the records you referenced with rhen_show or rhen_list (rhen_status {} shows what is current; ids may be stale), correct that field, ${RETRY_TAIL}`;
/** Columns every row carries, or that hold the portal's own bookkeeping: never a field an agent can send. */
const OWNER_COLUMNS = new Set(["user_id", "owner_id"]);
const INTERNAL_COLUMN = /(^|_)(token|hash|receipt|command|created_by|updated_by|version|request|actor)(_|$)/;

const camelCase = (column: string) => column.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());

/** The agent-facing names of the columns a constraint failure concerns, from the driver's `column_name` or `detail` ("Key (a, b)=(...)"). Never the values. */
function failingFields(error: unknown): string[] {
  const fields = error as { column_name?: unknown; detail?: unknown };
  if (typeof fields.column_name === "string" && fields.column_name !== "")
    return INTERNAL_COLUMN.test(fields.column_name) ? [] : [camelCase(fields.column_name)];
  const match = typeof fields.detail === "string" ? /^Key \(([a-z0-9_, ]+)\)=/i.exec(fields.detail) : null;
  if (!match) return [];
  return match[1]!
    .split(",")
    .map((column) => column.trim())
    .filter((column) => column !== "" && !OWNER_COLUMNS.has(column) && column !== "id" && !INTERNAL_COLUMN.test(column))
    .map(camelCase);
}

const fieldList = (fields: string[]) => fields.map((field) => `"${field}"`).join(", ");
const STATUS_CALL = {
  tool: "rhen_status",
  arguments: {},
  note: "shows the current plan and records; then rhen_show or rhen_list reads the ones you referenced"
};

/** The refusal body for a database error: text with the field and the way on, and the call to send next. */
function databaseRefusalBody(state: string, error: unknown): { error: string; nextCall: AgentCall } {
  const fields = failingFields(error);
  const detail = (error as { detail?: unknown }).detail;
  const named = fields.length === 0 ? "one of the ids or values you sent" : `the field ${fieldList(fields)}`;
  let message: string;
  switch (state) {
    case "23503":
      if (typeof detail === "string" && /is still referenced/i.test(detail))
        message =
          `This record is still in use by other records, so it cannot be removed or replaced. ${NOTHING_CHANGED} ` +
          "Read it with rhen_show and see rhen_guide {} for how to end or move what depends on it; change those first, or leave this one in place; " +
          RETRY_TAIL;
      else if (typeof detail === "string" && /is not present/i.test(detail))
        message = `${named === "one of the ids or values you sent" ? "A record you referenced" : `The record named by ${named}`} no longer exists (it may have just been removed or archived). ${NOTHING_CHANGED} ${READ_TAIL}`;
      else
        message =
          `${named === "one of the ids or values you sent" ? "A record you referenced" : `The record named by ${named}`} either no longer exists or is still in use by other records. ${NOTHING_CHANGED} ` +
          `${READ_TAIL}`;
      break;
    case "23505":
      message =
        `A record with the same ${fields.length === 0 ? "identifying values" : fieldList(fields)} already exists. ${NOTHING_CHANGED} ` +
        'Call rhen_status {} first, then find the existing record with rhen_search {"query":"<the name you used>"} and change that record instead of creating another, or choose a different value for that field, ' +
        RETRY_TAIL;
      break;
    case "23514":
      message = `${named === "one of the ids or values you sent" ? "A value you sent" : `The value of ${named}`} is not allowed. ${NOTHING_CHANGED} Read the tool's accepted values with rhen_guide {}, correct the value, ${RETRY_TAIL}`;
      break;
    case "23502":
      message = `A required value is missing${fields.length === 0 ? "" : `: ${fieldList(fields)}`}. ${NOTHING_CHANGED} Send ${fields.length === 0 ? "every required field" : "that field"} (rhen_guide {} lists what each save needs), ${RETRY_TAIL}`;
      break;
    default:
      message = `${fields.length === 0 ? "A value you sent" : `The value of ${named}`} is in the wrong format (an id, number or date that does not parse). ${NOTHING_CHANGED} Read the record with rhen_show to copy the exact format, correct the value, ${RETRY_TAIL}`;
  }
  return { error: message, nextCall: STATUS_CALL };
}

/** The SQLSTATE of a database error, or undefined for anything else. */
function sqlState(error: unknown): string | undefined {
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && code in DATABASE_REFUSALS ? code : undefined;
}

function errorCodeField(error: unknown): { errorCode?: string } {
  const errorCode = sqlState(error);
  return errorCode === undefined ? {} : { errorCode };
}

function truncate(value: string, limit: number) {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/**
 * The portal's only CSRF defence: there is no middleware, no per-route auth, and a mutating handler
 * that reads the body with `request.json()` accepts a cross-site `text/plain` "simple request" just
 * as happily as a same-origin one, since that shape never triggers a preflight.
 *
 * `Sec-Fetch-Site` is sent by every browser that still matters and cannot be spoofed by page script,
 * so `cross-site` is refused outright. A same-origin browser request, and any client that sends no
 * fetch metadata at all — curl, the ESP32 handheld, a LAN script — passes this check; those clients
 * have no notion of "site" to misreport; the point is to stop a *browser* carrying a signed-in
 * session to a third-party page. `Origin`, when a browser does send it, is checked against `Host` as
 * a second, independent signal for the same reason.
 *
 * No token, because this is a single-tenant household portal with no accounts: there is nothing to
 * prove possession of except "not a cross-site browser page", which is exactly what this checks.
 */
/** The response with one more `Set-Cookie`; a copy, because a fetched response's headers are immutable. */
function withCookie(response: Response, cookie: string): Response {
  // A handler that set the owner cookie itself (enrol, sign out) has the last word.
  if (response.headers.getSetCookie().some((existing) => existing.startsWith(`${OWNER_COOKIE}=`))) return response;
  const headers = new Headers(response.headers);
  headers.append("set-cookie", cookie);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function crossSiteRefusal(request: Request): Response | null {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;
  if (request.headers.get("sec-fetch-site") === "cross-site") return refusalResponse();
  const origin = request.headers.get("origin");
  if (origin === null) return null;
  const host = request.headers.get("host");
  let originHost: string | null;
  try {
    originHost = new URL(origin).host;
  } catch {
    originHost = null;
  }
  return originHost && host && originHost === host ? null : refusalResponse();
}

/**
 * DNS-rebinding defence: a page that rebinds its own name to the portal's address arrives with that
 * name in `Host`, and `crossSiteRefusal` alone cannot tell, since Origin and Host then match. Any
 * request (reads included) whose Host is not allowed is refused: the `PORTAL_ALLOWED_HOSTS` list when
 * set, otherwise loopback, the service name and `PORTAL_PUBLIC_URL` (see `portalHostAllowed`).
 */
function hostRefusal(request: Request): Response | null {
  return portalHostAllowed(request.headers.get("host"))
    ? null
    : Response.json({ error: "This host is not allowed." }, { status: 403 });
}

function refusalResponse(): Response {
  return Response.json({ error: "Cross-site requests are not allowed." }, { status: 403 });
}

/** Writes one line. Errors go to stderr so a container log filter can separate them from traffic. */
export function log(level: LogLevel, message: string, fields: RequestLine) {
  const line = JSON.stringify({ level, message, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}

/**
 * Wraps a route handler so that every request is timed and recorded, and so that an unexpected
 * throw becomes a generic 500 rather than an internal message on the user's screen.
 *
 * The command refusals keep the statuses and messages they always had: they are answers to the
 * request, not faults, and the message is the whole point of them. A Postgres constraint violation that
 * escapes a command is mapped the same way (see `DATABASE_REFUSALS`), with a message that names no SQL.
 *
 * `route` is the route template (`/api/imports/[id]`), not the request path, so that record
 * identifiers never enter the log.
 */
const gzipAsync = promisify(gzip);
/** Below this a gzip header and the CPU cost are not worth the bytes saved. */
const COMPRESS_FROM_BYTES = 8 * 1024;

/**
 * Gzips a large JSON answer for a client that accepts it. Every command answers with the whole state document
 * (~780 KB of repetitive JSON, a tenth of that gzipped), and over the tailnet that download, not the database, is
 * most of what a press waits for. A reverse proxy that already compresses leaves an answer alone once it carries a
 * `Content-Encoding`, and only JSON is touched, never an event stream.
 */
async function compressed(request: Request, response: Response): Promise<Response> {
  if (!response.body || response.headers.has("content-encoding") || response.status === 204 || response.status === 304)
    return response;
  if (!/\bgzip\b/i.test(request.headers.get("accept-encoding") ?? "")) return response;
  if (!/\bjson\b/i.test(response.headers.get("content-type") ?? "")) return response;
  const bytes = Buffer.from(await response.clone().arrayBuffer());
  if (bytes.length < COMPRESS_FROM_BYTES) return response;
  const body = await gzipAsync(bytes, { level: 4 });
  const headers = new Headers(response.headers);
  headers.set("content-encoding", "gzip");
  headers.set("content-length", String(body.length));
  const vary = headers.get("vary");
  if (!vary) headers.set("vary", "Accept-Encoding");
  else if (!/accept-encoding/i.test(vary)) headers.set("vary", `${vary}, Accept-Encoding`);
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

export function withRoute<Context = unknown>(
  route: string,
  handler: (request: Request, context: Context, log: RequestLog) => Response | Promise<Response>,
  options: RouteLogOptions = {}
) {
  return async (request: Request, context: Context): Promise<Response> =>
    compressed(request, withServerCommit(await serve(request, context)));

  async function serve(request: Request, context: Context): Promise<Response> {
    const startedAt = Date.now();
    let commandType: string | undefined;
    let caught: unknown;
    let mcp: McpLogFields = {};
    const requestLog: RequestLog = {
      setCommandType(value) {
        commandType = value;
      },
      setError(error) {
        caught = error;
      },
      setMcp(fields) {
        mcp = {
          ...mcp,
          ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))
        };
      }
    };
    const line = (status: number, error: unknown, withStack: boolean): RequestLine => ({
      route,
      method: request.method,
      status,
      durationMs: Date.now() - startedAt,
      ...(commandType === undefined ? {} : { commandType }),
      ...mcp,
      ...(error === undefined
        ? {}
        : {
            errorClass: error instanceof Error ? error.constructor.name : typeof error,
            ...errorCodeField(error),
            errorMessage: truncate(redact(error instanceof Error ? error.message : String(error)), 300)
          }),
      ...(withStack && error instanceof Error && error.stack ? { stack: truncate(redact(error.stack), 2000) } : {})
    });
    const refused = hostRefusal(request) ?? crossSiteRefusal(request);
    if (refused) {
      log("info", "Portal request refused", line(403, undefined, false));
      return refused;
    }
    const agent = parseAgentHeader(request.headers.get(AGENT_HEADER));
    if (agent === "invalid") {
      log("info", "Portal request refused", line(400, undefined, false));
      return Response.json(
        { error: "X-OpenRhen-Agent must be 1 to 32 characters of a-z, 0-9, _ or - and not a reserved name." },
        { status: 400 }
      );
    }
    // Like a bad agent name, a bad basis or evidence is a 400. The message names the header, never the value.
    const claim = parseClaimHeaders(request.headers);
    if (!claim.ok) {
      log("info", "Portal request refused", line(400, undefined, false));
      return Response.json({ error: claim.error }, { status: 400 });
    }
    const identity = await identifyRequest(request, route, agent);
    if (identity.refusal) {
      log("info", "Portal request refused", line(identity.refusal.status, undefined, false));
      return identity.refusal;
    }
    const owner = await ownerGate({ request, route, agent: identity.principal });
    noteOwnerOutcome(request, owner);
    if (owner.refusal) {
      log("info", "Portal request refused", line(owner.refusal.status, undefined, false));
      return owner.clearCookie ? withCookie(owner.refusal, ownerCookie(request, null)) : owner.refusal;
    }
    // `shadow`: say what `require` would have refused, then carry on exactly as `off` does.
    if (owner.wouldRefuse)
      log(
        "info",
        owner.wouldRefuse.worker
          ? "Worker auth would refuse"
          : owner.wouldRefuse.device
            ? "Device auth would refuse"
            : "Owner auth would refuse",
        {
          ...line(owner.wouldRefuse.status, owner.wouldRefuse.reason, false)
        }
      );
    // Agent time: a request that names an agent counts toward that agent's session (information only).
    if (identity.actor) void noteAgentCall(identity.actor, route, request.method);
    try {
      // A lapsed pulse holds every agent call but re-entry; the owner is not held here.
      if (identity.actor && !owner.owner) {
        const held = await reentryGate(route, new Date(), request.method);
        if (held) {
          log("info", "Portal request refused", line(held.status, undefined, false));
          return held;
        }
      }
      // A database token is held to its scopes by command and entity type; a write it may only propose is
      // filed here and answered 202, never reaching the handler.
      if (identity.principal?.source === "db") {
        const ended = await enforceAgentRequest(request, route, identity.principal, claim.claim);
        if (ended) {
          log(
            "info",
            ended.status >= 400 ? "Portal request refused" : "Portal request",
            line(ended.status, undefined, false)
          );
          return ended;
        }
      }
      const response = await runWithActor(
        owner.owner ? null : (identity.actor ?? null),
        () => handler(request, context, requestLog),
        undefined,
        claim.claim,
        identity.principal?.source === "db" ? (identity.principal.scopes ?? []) : undefined,
        identity.principal?.source === "db" ? (identity.principal.directWrites ?? {}) : undefined
      );
      const slidCookie = owner.slid ? cookieValue(request, OWNER_COOKIE) : undefined;
      const answered = slidCookie
        ? withCookie(response, ownerCookie(request, slidCookie))
        : owner.clearCookie
          ? withCookie(response, ownerCookie(request, null))
          : response;
      const failed = response.status >= 500;
      if (!options.probe || response.status >= 400)
        log(failed ? "error" : "info", failed ? "Portal request failed" : "Portal request", {
          ...line(response.status, response.status >= 400 ? caught : undefined, failed)
        });
      return answered;
    } catch (error) {
      // The write committed and only the answer's read failed: never a 500, which would read as "nothing landed".
      // 503 with `committed`/`retryable`, so a caller repeats the same command id (a receipt replay) to read it.
      if (error instanceof CommittedReadFailedError) {
        log("error", "Portal request failed", line(503, error, true));
        return Response.json(
          { error: error.message, committed: true, retryable: true },
          { status: 503, headers: { "Retry-After": "2" } }
        );
      }
      const known =
        error instanceof CommandConflictError ||
        error instanceof CommandIdReusedError ||
        error instanceof InvalidCommandError ||
        error instanceof ForbiddenCommandError ||
        error instanceof NotFoundCommandError;
      const state = known ? undefined : sqlState(error);
      if (state) {
        const refusal = DATABASE_REFUSALS[state]!;
        // A refusal, but the stack stays in the log: a constraint that fires here is also how a missing
        // check in a command shows up, and the cause should not be lost along with the 500.
        log(refusal.level, "Portal request refused", line(refusal.status, error, true));
        return Response.json(databaseRefusalBody(state, error), { status: refusal.status });
      }
      const status = !known
        ? 500
        : error instanceof CommandConflictError || error instanceof CommandIdReusedError
          ? 409
          : error instanceof ForbiddenCommandError
            ? 403
            : error instanceof NotFoundCommandError
              ? 404
              : 400;
      log(known ? "info" : "error", known ? "Portal request refused" : "Portal request failed", {
        ...line(status, error, !known)
      });
      return Response.json(
        {
          error: known && error instanceof Error ? redact(error.message) : "The request failed.",
          ...(error instanceof CommandConflictError && error.currentVersion !== undefined
            ? { currentVersion: error.currentVersion }
            : {}),
          // A refusal that knows the exact next call and the accepted values sends them beside the text.
          ...(error instanceof CommandConflictError ||
          error instanceof InvalidCommandError ||
          error instanceof ForbiddenCommandError ||
          error instanceof NotFoundCommandError
            ? {
                ...(error.nextCall === undefined ? {} : { nextCall: error.nextCall }),
                ...(error.validValues === undefined ? {} : { validValues: error.validValues })
              }
            : {})
        },
        { status }
      );
    }
  }
}
