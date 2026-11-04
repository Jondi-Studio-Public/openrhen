import { BASIS_HEADER, EVIDENCE_HEADER } from "@openrhen/contracts";
import { memoryJournal, runCli, type Journal } from "@openrhen/cli/in-process";
import { vouchForRequest, type AgentPrincipal } from "./agent-tokens";
import { publicOrigin } from "./mcp-oauth";
import "./drop-ins";
import { MCP_ROUTE_TABLE, type RouteModule } from "./mcp-route-table";
import { vouchOwnerRequest } from "./owner-auth";

/**
 * Runs a real CLI command inside the portal process. The remote `/mcp`
 * endpoint turns a tool call into the stdio server's own command line and runs it here, so a remote tool behaves
 * exactly like its stdio twin. The CLI believes it is talking to a portal at `IN_PROCESS_ORIGIN`; its `fetch` is
 * replaced by one that
 *
 * - refuses any URL whose origin is not that one, so the CLI can reach nothing else from here;
 * - finds the route handler in the generated table (`mcp-route-table.ts`) and refuses a path that is not in it;
 * - builds a fresh `Request` from the method, body and the few headers a portal route reads (never the CLI's own
 *   token or owner headers), addressed as the inbound caller addressed this server;
 * - vouches the request for the actor, so the normal `withRoute` wrapper takes it as authenticated: scope checks,
 *   `directWrites`, the hard floor, basis and evidence all apply as they would over HTTP.
 *
 * The CLI gets an environment built here, never the server's `process.env`, no config file and no state file.
 */

/** Where the in-process CLI thinks the portal is. A private-looking name, so the CLI's own address check passes. */
export const IN_PROCESS_ORIGIN = "http://openrhen.localhost";

/**
 * Stands in for `OPENRHEN_TOKEN` so the CLI behaves as the stdio server does for a token-holding agent (a large
 * `bulk` is filed as one proposal). It is not a credential: the fetch below never forwards it.
 */
const TOKEN_PLACEHOLDER = "in-process";

/** The only request headers that reach a route handler from the CLI. */
const FORWARDED_HEADERS = ["accept", "content-type", BASIS_HEADER.toLowerCase(), EVIDENCE_HEADER.toLowerCase()];

/** Copied from the inbound request, so the host allowlist and the failure throttle see what they would over HTTP. */
const ADDRESSING_HEADERS = ["host", "x-forwarded-for", "x-forwarded-proto"];

export type CliActor =
  /** A token's agent: the request is vouched as this principal and held to its scopes. */
  | { kind: "agent"; principal: AgentPrincipal }
  /**
   * The owner, already authenticated by the caller (an owner-only route). The request counts as the person: no agent
   * identity, no scope enforcement. Never build this from anything a token holder controls.
   */
  | { kind: "owner" };

export type RouteLoader = (template: string) => Promise<RouteModule | undefined>;

const tableLoader: RouteLoader = async (template) => MCP_ROUTE_TABLE[template]?.();

export interface RunCliInProcessOptions {
  /** The full command line, without the program name, exactly as `toolInvocation` builds it. */
  argv: readonly string[];
  actor: CliActor;
  /** The record of reversible writes behind `undo`; a fresh in-memory one when absent. */
  journal?: Journal | undefined;
  /** The request being served: its host and forwarding headers address the sub-requests. */
  inbound: Request;
  /** Where route handlers come from; the generated table unless a test injects stubs. */
  loadRoute?: RouteLoader | undefined;
}

export interface CliRunResult {
  exitCode: number;
  stdout: string[];
  stderr: string[];
  /** Set when a sub-request was answered 403 with `requiredScopes`: what the token lacked. */
  insufficientScopes?: string[];
  /** True when a route handler (or the table) threw instead of answering: the portal could not run it just now. */
  failed: boolean;
  /** True when a route answered 503: the portal could not finish just now (a committed write whose answer could not be read back), and repeating the same command id is safe. */
  retryable?: boolean;
  /** With `failed`: what to tell the caller instead of the generic "try again" (a refusal made before the command ran). */
  retryMessage?: string;
}

interface Segment {
  text: string;
  dynamic: boolean;
}

const segmentsOf = (template: string): Segment[] =>
  template
    .split("/")
    .slice(1)
    .map((text) => ({ text, dynamic: /^\[[^\].]+\]$/.test(text) }));

export interface RouteMatch {
  template: string;
  /** The dynamic segments, decoded, keyed by the name in brackets. */
  params: Record<string, string>;
}

/** The template a path belongs to. A static segment beats a dynamic one at the first place they differ. */
export function matchRoute(
  pathname: string,
  templates: readonly string[] = Object.keys(MCP_ROUTE_TABLE)
): RouteMatch | undefined {
  const parts = pathname.split("/").slice(1);
  let best: { template: string; segments: Segment[]; params: Record<string, string> } | undefined;
  for (const template of templates) {
    const segments = segmentsOf(template);
    if (segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let fits = true;
    for (const [index, segment] of segments.entries()) {
      const part = parts[index] as string;
      if (segment.dynamic) {
        if (part === "") {
          fits = false;
          break;
        }
        try {
          params[segment.text.slice(1, -1)] = decodeURIComponent(part);
        } catch {
          fits = false;
          break;
        }
      } else if (segment.text !== part) {
        fits = false;
        break;
      }
    }
    if (!fits) continue;
    if (best === undefined || moreSpecific(segments, best.segments)) best = { template, segments, params };
  }
  return best && { template: best.template, params: best.params };
}

function moreSpecific(a: Segment[], b: Segment[]): boolean {
  for (const [index, segment] of a.entries()) {
    const other = b[index] as Segment;
    if (segment.dynamic !== other.dynamic) return !segment.dynamic;
  }
  return false;
}

interface FetchState {
  insufficientScopes?: string[];
  retryable?: boolean;
  failed: boolean;
}

/** The `fetch` the CLI is given. Exported for tests; nothing else should build one. */
export function createInProcessFetch(
  options: Pick<RunCliInProcessOptions, "actor" | "inbound" | "loadRoute">,
  state: FetchState = { failed: false }
): typeof fetch {
  const loadRoute = options.loadRoute ?? tableLoader;
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== IN_PROCESS_ORIGIN)
      throw new Error(`Only the portal itself can be reached from here; ${url.origin} is refused.`);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body;
    if (body !== undefined && body !== null && typeof body !== "string")
      throw new Error("Only text request bodies can be sent from here.");
    const matched = matchRoute(url.pathname);
    if (!matched) return Response.json({ error: `There is no portal route ${url.pathname}.` }, { status: 404 });
    let handler: RouteModule[keyof RouteModule];
    try {
      handler = (await loadRoute(matched.template))?.[method as keyof RouteModule];
    } catch (error) {
      state.failed = true;
      throw error;
    }
    if (!handler) return Response.json({ error: `${method} ${url.pathname} is not available.` }, { status: 405 });

    const given = new Headers(init?.headers);
    const headers = new Headers();
    for (const name of FORWARDED_HEADERS) {
      const value = given.get(name);
      if (value !== null) headers.set(name, value);
    }
    for (const name of ADDRESSING_HEADERS) {
      const value = options.inbound.headers.get(name);
      if (value) headers.set(name, value);
    }
    const request = new Request(`${publicOrigin(options.inbound)}${url.pathname}${url.search}`, {
      method,
      headers,
      ...(typeof body === "string" ? { body } : {})
    });
    if (options.actor.kind === "agent") vouchForRequest(request, options.actor.principal);
    else vouchOwnerRequest(request);
    const context = Object.keys(matched.params).length > 0 ? { params: Promise.resolve(matched.params) } : undefined;

    const answered = (async () =>
      (handler as (request: Request, context: unknown) => Response | Promise<Response>)(request, context))();
    answered.catch(() => {});
    let response: Response;
    try {
      response = await withSignal(answered, init?.signal);
    } catch (error) {
      if (!(error instanceof DOMException)) state.failed = true;
      throw error;
    }
    if (response.status === 503) state.retryable = true;
    if (response.status === 403) {
      const refused = (await response
        .clone()
        .json()
        .catch(() => undefined)) as { requiredScopes?: unknown } | undefined;
      if (
        state.insufficientScopes === undefined &&
        Array.isArray(refused?.requiredScopes) &&
        refused.requiredScopes.every((scope) => typeof scope === "string")
      )
        state.insufficientScopes = refused.requiredScopes as string[];
    }
    return response;
  };
}

/** `promise`, or its rejection with the signal's reason as `fetch` would give it once the signal aborts. */
function withSignal<T>(promise: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** What the CLI sees as its environment: the in-process portal, and for an agent its name. Nothing from the server's own. */
export function cliEnvironment(actor: CliActor): Record<string, string> {
  return actor.kind === "agent"
    ? {
        OPENRHEN_URL: IN_PROCESS_ORIGIN,
        OPENRHEN_AGENT: actor.principal.name,
        OPENRHEN_TOKEN: TOKEN_PLACEHOLDER
      }
    : { OPENRHEN_URL: IN_PROCESS_ORIGIN };
}

/**
 * Runs `argv` through the real CLI as `actor`. The exit code and the output come back as the CLI produced them;
 * the endpoint decides what to tell the caller.
 */
export async function runCliInProcess(options: RunCliInProcessOptions): Promise<CliRunResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const state: FetchState = { failed: false };
  const exitCode = await runCli(options.argv, {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    env: cliEnvironment(options.actor) as NodeJS.ProcessEnv,
    fetchImpl: createInProcessFetch(options, state),
    readConfigFile: () => null,
    readStateFile: () => {
      throw new Error("State files are not available here.");
    },
    journal: options.journal ?? memoryJournal(),
    byOwner: options.actor.kind === "owner",
    remote: true
  });
  return {
    exitCode,
    stdout,
    stderr,
    failed: state.failed,
    ...(state.retryable ? { retryable: true } : {}),
    ...(state.insufficientScopes === undefined ? {} : { insufficientScopes: state.insufficientScopes })
  };
}
