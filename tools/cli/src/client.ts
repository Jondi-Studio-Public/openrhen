import {
  planningRuntimeStateSchema,
  portalStateSchema,
  type PlanningRuntimeState,
  type PortalStateContract
} from "@openrhen/contracts";
import { AGENT_HEADER, OWNER_TOKEN_HEADER, TOKEN_HEADER, claimHeaders, type WriteClaim } from "./agent.js";
import { assertPrivateAddresses, type AddressLookup, type CliConfig } from "./config.js";
import { CliError, EXIT, NetworkError, ServerError, type CliErrorAgentFields } from "./errors.js";

/**
 * What `GET /api/state` returns: the contract's planning document plus the engine's latest result,
 * which the portal attaches as `planning` (see `portal/features/planning/planning-runtime.ts`).
 */
export interface PortalState extends PortalStateContract {
  planning?: (PlanningRuntimeState & { awaitingRecalculation?: boolean }) | undefined;
}

export interface BinaryDownload {
  bytes: Uint8Array;
  contentType: string;
  /** Parsed from the response's Content-Disposition header when present; null otherwise. */
  filename: string | null;
  /** Response headers, names lower-cased. */
  headers: Record<string, string>;
}

/** Sent by every portal response (when the portal knows its own build): the commit it is running. */
export const SERVER_COMMIT_HEADER = "x-openrhen-server-commit";
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;

export interface PortalClient {
  readonly baseUrl: string;
  getState(): Promise<PortalState>;
  get<T = unknown>(path: string): Promise<T>;
  post<T = unknown>(path: string, body: unknown): Promise<T>;
  // Optional: only the real client implements these. A stub client (e.g. cli.ts's offline client)
  // can still satisfy this interface without them; callers that need them check first.
  put?<T = unknown>(path: string, body: unknown): Promise<T>;
  del?<T = unknown>(path: string): Promise<T>;
  /** Fetches a raw file (e.g. a retained deliverable source file) from a portal path, honouring the same
   * origin, timeout, and HTTP/network error mapping as every other request — just without JSON-parsing
   * the body. */
  getBinary?(path: string): Promise<BinaryDownload>;
  /** The portal's commit from the most recent response that carried one; null before any, or when unknown. */
  serverCommit?(): string | null;
}

export interface ClientOptions {
  fetchImpl?: typeof fetch;
  /** Where contract mismatches are reported; they never stop a read. */
  warn?: (message: string) => void;
  /**
   * Second guard behind the command-level `--read-only`/`--state-file` check in cli.ts: refuses any
   * non-GET request before it ever reaches `fetchImpl`, so a mutating call cannot slip through even
   * if a command's own code (incorrectly) tried to send one.
   */
  readOnly?: boolean;
  /** Sent as `X-OpenRhen-Agent` on every request when set; no header otherwise. */
  agent?: string | undefined;
  /** Sent as `X-OpenRhen-Token` on every request when set; never printed or put in an error. */
  token?: string | undefined;
  /** Sent as `X-OpenRhen-Owner` on every request when set (never beside an agent identity); never printed. */
  ownerToken?: string | undefined;
  /** Sent as `X-OpenRhen-Basis` / `X-OpenRhen-Evidence` on every write (not on reads) when set. */
  claim?: WriteClaim | undefined;
  /** Resolves the host when `config.checkAddresses` is set; the system resolver unless a test injects one. */
  lookup?: AddressLookup;
}

/** `promise`, or the error from `onTimeout` once `ms` passes; the timer never keeps the process alive. */
function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
    timer.unref?.();
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

function unreachableMessage(config: CliConfig, reason: string): string {
  return config.fromDefault
    ? `No portal at ${config.url}. Set OPENRHEN_URL or \`url\` in ~/.openrhen/config.json.`
    : `Cannot reach the portal at ${config.url}: ${reason}`;
}

export function createClient(config: CliConfig, options: ClientOptions = {}): PortalClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const warn = options.warn ?? ((message: string) => console.error(message));
  const readOnly = options.readOnly ?? false;
  const token = options.token;
  const ownerToken = options.ownerToken;
  let seenServerCommit: string | null = null;
  const noteServerCommit = (response: Response) => {
    const value = response.headers.get(SERVER_COMMIT_HEADER)?.trim();
    // The value reaches an agent's context as a note, so only a commit sha is kept, never free text.
    if (value && COMMIT_PATTERN.test(value)) seenServerCommit = value;
  };
  let hostChecked: Promise<void> | undefined;
  const checkHost = () => {
    if (!config.checkAddresses) return Promise.resolve();
    // Only a pass is kept: a failed or timed-out check is forgotten, so the next request (a retry) looks again.
    hostChecked ??= withTimeout(
      assertPrivateAddresses(new URL(config.url).hostname, options.lookup),
      config.timeoutMs,
      () => new NetworkError(`The portal at ${config.url} did not answer within ${config.timeoutMs} ms.`)
    ).catch((error: unknown) => {
      hostChecked = undefined;
      throw error;
    });
    return hostChecked;
  };
  const writeClaimHeaders = options.claim ? claimHeaders(options.claim) : {};
  const agentHeader: Record<string, string> = {
    ...(options.agent ? { [AGENT_HEADER]: options.agent } : {}),
    ...(token ? { [TOKEN_HEADER]: token } : {}),
    ...(ownerToken ? { [OWNER_TOKEN_HEADER]: ownerToken } : {})
  };

  async function request<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
    if (readOnly && method !== "GET")
      throw new CliError(`Read-only mode: refusing to send ${method} ${path}.`, EXIT.usage);
    await checkHost();
    const url = new URL(path, config.url).toString();
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          accept: "application/json",
          ...agentHeader,
          ...(method === "GET" ? {} : writeClaimHeaders),
          ...(body === undefined ? {} : { "content-type": "application/json" })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(config.timeoutMs)
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new NetworkError(
        timedOut
          ? `The portal at ${config.url} did not answer within ${config.timeoutMs} ms.`
          : unreachableMessage(config, reason)
      );
    }
    noteServerCommit(response);
    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
    if (response.ok) return payload as T;
    throw errorFor(response.status, path, payload, token, ownerToken);
  }

  function parseDispositionFilename(header: string | null): string | null {
    if (!header) return null;
    const starred = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(header);
    if (starred?.[1]) {
      const raw = starred[1].trim().replace(/^"|"$/g, "");
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
    const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
    return plain?.[1]?.trim() ?? null;
  }

  async function getBinary(path: string): Promise<BinaryDownload> {
    await checkHost();
    const url = new URL(path, config.url).toString();
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: agentHeader,
        redirect: "error",
        signal: AbortSignal.timeout(config.timeoutMs)
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new NetworkError(
        timedOut
          ? `The portal at ${config.url} did not answer within ${config.timeoutMs} ms.`
          : unreachableMessage(config, reason)
      );
    }
    noteServerCommit(response);
    if (!response.ok) {
      const text = await response.text();
      let payload: unknown = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = text;
        }
      }
      throw errorFor(response.status, path, payload, token, ownerToken);
    }
    const buffer = await response.arrayBuffer();
    return {
      bytes: new Uint8Array(buffer),
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
      filename: parseDispositionFilename(response.headers.get("content-disposition")),
      headers: Object.fromEntries(response.headers.entries())
    };
  }

  return {
    baseUrl: config.url,
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    put: (path, body) => request("PUT", path, body),
    del: (path) => request("DELETE", path),
    getBinary,
    serverCommit: () => seenServerCommit,
    async getState() {
      const payload = await request<{ state?: unknown }>("GET", "/api/state");
      const raw = payload?.state;
      if (!raw || typeof raw !== "object")
        throw new CliError("The portal's state response carried no state object.", EXIT.unavailable);
      return normaliseState(raw as Record<string, unknown>, warn);
    }
  };
}

/**
 * The contract fills defaults and refuses inconsistent documents. A refusal is reported, not fatal:
 * a read-only tool that goes blind whenever the portal is one migration ahead of it is worse than
 * one that shows the document as sent.
 */
export function normaliseState(raw: Record<string, unknown>, warn: (message: string) => void): PortalState {
  const { planning: rawPlanning, ...document } = raw;
  const parsed = portalStateSchema.safeParse(document);
  let state: PortalState;
  if (parsed.success) state = parsed.data;
  else {
    const first = parsed.error.issues[0];
    warn(
      `rhen: the portal's state does not match the contract (${first ? `${first.path.join(".")}: ${first.message}` : "unknown issue"}); showing it as sent.`
    );
    state = document as unknown as PortalState;
  }
  if (rawPlanning && typeof rawPlanning === "object") {
    const planning = planningRuntimeStateSchema.safeParse(rawPlanning);
    const awaiting = (rawPlanning as { awaitingRecalculation?: unknown }).awaitingRecalculation;
    state.planning = {
      ...(planning.success ? planning.data : (rawPlanning as PlanningRuntimeState)),
      ...(typeof awaiting === "boolean" ? { awaitingRecalculation: awaiting } : {})
    };
  }
  return state;
}

const isNextCall = (value: unknown): value is NonNullable<CliErrorAgentFields["nextCall"]> =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { tool?: unknown }).tool === "string" &&
  typeof (value as { arguments?: unknown }).arguments === "object" &&
  (value as { arguments?: unknown }).arguments !== null;

const isValidValues = (value: unknown): value is Record<string, string[]> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((list) => Array.isArray(list) && list.every((item) => typeof item === "string"));

function errorFor(status: number, path: string, payload: unknown, token?: string, ownerToken?: string): CliError {
  const body =
    payload && typeof payload === "object"
      ? (payload as {
          error?: unknown;
          issues?: unknown;
          missingScopes?: unknown;
          suggestedPath?: unknown;
          currentVersion?: unknown;
          nextCall?: unknown;
          validValues?: unknown;
        })
      : {};
  let message = typeof body.error === "string" ? body.error : `HTTP ${status} from ${path}`;
  if (token) message = message.split(token).join("[token]");
  if (ownerToken) message = message.split(ownerToken).join("[token]");
  // A lapsed pulse holds every agent call but `reenter`; the body carries the pulse fields and what is missing.
  if ((payload as { code?: unknown } | null)?.code === "reentryRequired")
    return new CliError(message, EXIT.reentry, payload);
  if (status === 422) return new CliError(message, EXIT.validation, payload);
  if (status === 401 || status === 403) {
    // The portal's own message says why; a 403 with a token means the token's agent may not write here.
    const explained = /\bscope\b|rhen propose|owner|\bperson\b/.test(message);
    const note = status === 403 && token && !explained ? " (this token's agent is not allowed to write there)" : "";
    if (status === 403 && Array.isArray(body.missingScopes))
      return new CliError(`${message}${note}`, EXIT.usage, undefined, { code: "scope" });
    // Any other 403 is the portal refusing this agent the call (the hard floor, an owner-only route): guarded, and
    // when the refusal names a command to run instead it travels as `suggestedPath`.
    return new CliError(
      `${message}${note}`,
      EXIT.usage,
      undefined,
      status === 403
        ? {
            code: "guarded",
            ...(typeof body.suggestedPath === "string" ? { suggestedPath: body.suggestedPath } : {})
          }
        : {}
    );
  }
  // A refusal that names the exact next call and the accepted values (the portal's not-found, wrong-state and
  // invalid-choice texts) carries them beside the message; they are passed through only when well formed.
  const guidance: CliErrorAgentFields = {
    ...(isNextCall(body.nextCall) ? { nextCall: body.nextCall } : {}),
    ...(isValidValues(body.validValues) ? { validValues: body.validValues } : {})
  };
  if (status === 400) return new CliError(message, EXIT.validation, body.issues, guidance);
  if (status === 409)
    return new CliError(message, EXIT.conflict, body.issues, {
      ...guidance,
      ...(typeof body.currentVersion === "number" ? { currentVersion: body.currentVersion } : {})
    });
  if (status === 404) return new CliError(message, EXIT.notFound, undefined, guidance);
  if (status >= 500) return new ServerError(message, status, payload);
  return new CliError(message, EXIT.unavailable, payload);
}
