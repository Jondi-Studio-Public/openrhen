import { createHash, timingSafeEqual } from "node:crypto";
import { rateLimitMessage, type DirectWrites } from "@openrhen/contracts";
import { replaceExpiredTokenFor } from "./agent-token-recipe";
import { remoteAddress, sharedFailureThrottle, type FailureThrottle } from "./agent-token-throttle";

/** The header an agent sends its token in. Not `Authorization`: the location ping and the device-registration routes already use that for their own keys. */
export const AGENT_TOKEN_HEADER = "x-openrhen-token";

// Read straight from the environment, not through `runtime-env`: `withRoute` runs for every route, and
// the many route tests that mock that module must not each have to know about these two settings.
const tokensConfig = () => process.env.OPENRHEN_AGENT_TOKENS?.trim() || undefined;
const authMode = (): "off" | "require" =>
  process.env.OPENRHEN_AGENT_AUTH?.trim().toLowerCase() === "require" ? "require" : "off";

const NAME = /^[a-z0-9_-]{1,32}$/;
const RESERVED = new Set(["system", "human"]);

export interface AgentTokenEntry {
  name: string;
  /** `sha256(token)`, 32 bytes. */
  hash: Buffer;
  /** `none`, `all`, or route templates (exact, or a trailing `*` for a prefix) this agent may write to. */
  writes: "none" | "all" | string[];
}

export type AgentTokenTable = { ok: true; entries: AgentTokenEntry[] } | { ok: false; error: string };

/**
 * Parses `OPENRHEN_AGENT_TOKENS`: a JSON array of `{ name, sha256, writes }`. The environment holds
 * only hashes, so a leaked config reveals no usable token; the raw token lives in the agent's own
 * environment. A malformed table is an error, never an empty one, so a typo cannot silently turn
 * enforcement off. Unset is a valid empty table.
 */
export function parseAgentTokens(raw: string | undefined): AgentTokenTable {
  if (raw === undefined || raw.trim() === "") return { ok: true, entries: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "OPENRHEN_AGENT_TOKENS is not valid JSON." };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: "OPENRHEN_AGENT_TOKENS must be a JSON array." };
  const entries: AgentTokenEntry[] = [];
  const names = new Set<string>();
  for (const item of parsed) {
    const entry = item as { name?: unknown; sha256?: unknown; writes?: unknown } | null;
    const name = typeof entry?.name === "string" ? entry.name : "";
    if (!NAME.test(name) || RESERVED.has(name))
      return { ok: false, error: `OPENRHEN_AGENT_TOKENS has a bad agent name "${name}".` };
    if (names.has(name)) return { ok: false, error: `OPENRHEN_AGENT_TOKENS names "${name}" twice.` };
    names.add(name);
    if (typeof entry?.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256))
      return { ok: false, error: `OPENRHEN_AGENT_TOKENS: "${name}" needs a lowercase hex sha256.` };
    const writes = entry.writes ?? "none";
    const valid =
      writes === "none" ||
      writes === "all" ||
      (Array.isArray(writes) && writes.every((route) => typeof route === "string" && route.startsWith("/api/")));
    if (!valid)
      return { ok: false, error: `OPENRHEN_AGENT_TOKENS: "${name}" writes must be none, all, or /api/ routes.` };
    entries.push({ name, hash: Buffer.from(entry.sha256, "hex"), writes: writes as AgentTokenEntry["writes"] });
  }
  return { ok: true, entries };
}

export type TokenResolution =
  { kind: "agent"; entry: AgentTokenEntry } | { kind: "refused"; status: 401 | 503; error: string };

/** Finds the agent a presented token belongs to. A wrong token is a 401, never a downgrade to anonymous. */
export function resolveAgentToken(presented: string, table: AgentTokenTable): TokenResolution {
  if (!table.ok) return { kind: "refused", status: 503, error: "Agent tokens are misconfigured on the portal." };
  const digest = createHash("sha256").update(presented).digest();
  // Compare against every entry so the time taken does not say which names exist.
  let found: AgentTokenEntry | undefined;
  for (const entry of table.entries) if (timingSafeEqual(digest, entry.hash)) found = entry;
  return found
    ? { kind: "agent", entry: found }
    : { kind: "refused", status: 401, error: "The agent token is not recognised." };
}

/** Whether a token's scope lets it write to this route template. */
export function writeAllowed(writes: AgentTokenEntry["writes"], route: string): boolean {
  if (writes === "all") return true;
  if (writes === "none") return false;
  return writes.some((allowed) => (allowed.endsWith("*") ? route.startsWith(allowed.slice(0, -1)) : allowed === route));
}

const isRead = (method: string) => ["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());

/** A database token as the check reads it (`agent-token-store.ts` produces it). */
export interface DbTokenRecord {
  id: string;
  name: string;
  /** `sha256(token)` as lower-case hex. */
  tokenHash: string;
  scopes: string[];
  directWrites: DirectWrites;
  expiresAt: Date;
  revokedAt: Date | null;
}

/**
 * Who a token says the caller is. A database token carries scopes and `directWrites`, which the route wrapper
 * enforces by command and entity type (`agent-enforcement.ts`); an environment token carries only a route list,
 * enforced here as before, so `scopes` is absent.
 */
export interface AgentPrincipal {
  name: string;
  source: "db" | "env";
  tokenId?: string;
  scopes?: string[];
  directWrites: DirectWrites;
}

export interface IdentifyDeps {
  /** Finds a database token by the hex sha256 of what was presented. Throwing means the table could not be read. */
  lookup?: (hash: string) => Promise<DbTokenRecord | null>;
  /** Called after a database token is accepted; the store keeps it to once a minute. */
  touch?: (id: string) => void;
  throttle?: FailureThrottle;
  now?: () => Date;
}

/** The production lookup. Imported on first use so a request with no token never loads the database layer. */
async function databaseLookup(hash: string): Promise<DbTokenRecord | null> {
  const [{ databaseUrl }, { sqlPool }, { findAgentTokenByHash }] = await Promise.all([
    import("./runtime-env"),
    import("./persistence/postgres/sql-pool"),
    import("./agent-token-store")
  ]);
  const url = databaseUrl();
  return url ? findAgentTokenByHash(sqlPool(url), hash) : null;
}

function databaseTouch(id: string): void {
  void (async () => {
    try {
      const [{ databaseUrl }, { sqlPool }, { touchAgentToken }] = await Promise.all([
        import("./runtime-env"),
        import("./persistence/postgres/sql-pool"),
        import("./agent-token-store")
      ]);
      const url = databaseUrl();
      if (url) await touchAgentToken(sqlPool(url), id);
    } catch {
      // A missed `last_used_at` must never fail the request it describes.
    }
  })();
}

const refuse = (status: number, error: string, headers?: Record<string, string>) =>
  Response.json({ error }, { status, ...(headers ? { headers } : {}) });

/**
 * Requests the portal builds for itself, already authenticated: the remote `/mcp` endpoint resolves an
 * audience-bound access token to its agent and runs the tool's route in-process as that agent. Keyed by the
 * `Request` object, so only code in this process can add to it; a request off the wire is never in it.
 */
const vouched = new WeakMap<Request, AgentPrincipal>();

/** Marks an in-process request as made by `principal`, so `identifyRequest` takes it as authenticated. */
export function vouchForRequest(request: Request, principal: AgentPrincipal): void {
  vouched.set(request, principal);
}

export interface Identity {
  actor: string | undefined;
  refusal?: Response;
  /** Set when a valid token named the caller; absent for a header-only name or an anonymous caller. */
  principal?: AgentPrincipal;
}

/**
 * Decides who a request is, before the handler runs. `actor` is the name to stamp (undefined = a
 * person, no header); `refusal` is a ready response. A valid token names the actor itself, and the
 * self-declared `X-OpenRhen-Agent` header is then ignored. The database table is consulted first and the
 * environment table second, so a token found in the database wins. With `OPENRHEN_AGENT_AUTH=require`, a
 * self-declared name with no token is refused, so a named agent cannot skip its scope; an anonymous
 * request is still treated as a person (the portal cannot tell a silent agent from the owner on the LAN).
 * Ten unrecognised tokens a minute from one address are answered 429; a wrong token is otherwise a 401.
 */
export async function identifyRequest(
  request: Request,
  route: string,
  declared: string | undefined,
  table: AgentTokenTable = parseAgentTokens(tokensConfig()),
  mode: "off" | "require" = authMode(),
  deps: IdentifyDeps = {}
): Promise<Identity> {
  const internal = vouched.get(request);
  if (internal) return { actor: internal.name, principal: internal };
  const presented = request.headers.get(AGENT_TOKEN_HEADER);
  if (presented === null || presented.trim() === "") {
    if (declared !== undefined && mode === "require")
      return { actor: undefined, refusal: refuse(401, "A named agent must present its token (X-OpenRhen-Token).") };
    return { actor: declared };
  }
  const throttle = deps.throttle ?? sharedFailureThrottle;
  const address = remoteAddress(request.headers);
  const wait = throttle.retryAfter(address);
  if (wait > 0)
    return {
      actor: undefined,
      refusal: Response.json(
        { error: rateLimitMessage(wait, "unrecognised agent tokens"), retryAfterSeconds: wait },
        { status: 429, headers: { "retry-after": String(wait) } }
      )
    };
  const fail = (status: 401 | 503, error: string): Identity => {
    if (status === 401) throttle.fail(address);
    return { actor: undefined, refusal: refuse(status, error) };
  };

  const token = presented.trim();
  const digest = createHash("sha256").update(token).digest();
  let tableUnreadable = false;
  let stored: DbTokenRecord | null = null;
  try {
    stored = await (deps.lookup ?? databaseLookup)(digest.toString("hex"));
  } catch {
    // The table may be missing mid-migration or the database down: environment tokens still work.
    tableUnreadable = true;
  }
  if (stored && stored.tokenHash.length === 64 && timingSafeEqual(digest, Buffer.from(stored.tokenHash, "hex"))) {
    const now = (deps.now ?? (() => new Date()))();
    // A revoked or expired token is a known hash, not a guess, so it does not count against the throttle.
    // Only a pasted token shows this to the model, and only after the constant-time hash match: the text holds the
    // token's name (`[a-z0-9_-]{1,32}`), never the token, id or hash.
    if (stored.revokedAt)
      return {
        actor: undefined,
        refusal: refuse(
          401,
          `The agent token "${stored.name}" was revoked, so nothing was done. Do not retry. Tell the owner it was ` +
            `revoked and ask whether they want it replaced. If the owner is not in this conversation, put that in ` +
            `your next report.`
        )
      };
    if (stored.expiresAt.getTime() <= now.getTime())
      return {
        actor: undefined,
        refusal: refuse(
          401,
          `The agent token "${stored.name}" expired on ${stored.expiresAt.toISOString().slice(0, 10)}, so nothing was ` +
            `done. Do not retry. Tell the owner: "This agent's token has expired; please issue a replacement (in a ` +
            `terminal: ${replaceExpiredTokenFor(stored.scopes, stored.name)})." If the owner is not in this conversation, put ` +
            `that in your next report.`
        )
      };
    (deps.touch ?? databaseTouch)(stored.id);
    return {
      actor: stored.name,
      principal: {
        name: stored.name,
        source: "db",
        tokenId: stored.id,
        scopes: stored.scopes,
        directWrites: stored.directWrites
      }
    };
  }

  const resolved = resolveAgentToken(token, table);
  if (resolved.kind === "refused")
    return resolved.status === 401 && tableUnreadable
      ? fail(503, "Agent tokens could not be checked just now; try again.")
      : fail(resolved.status, resolved.error);
  if (!isRead(request.method) && !writeAllowed(resolved.entry.writes, route))
    return {
      actor: resolved.entry.name,
      refusal: refuse(403, `The agent "${resolved.entry.name}" may not write to this route.`)
    };
  return {
    actor: resolved.entry.name,
    principal: { name: resolved.entry.name, source: "env", directWrites: {} }
  };
}
