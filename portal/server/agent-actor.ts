import { AsyncLocalStorage } from "node:async_hooks";
import { BASIS_HEADER, EVIDENCE_HEADER, parseBasis, parseEvidenceHeader, type AgentBasis } from "@openrhen/contracts";

/** The header an agent names itself with. A label, not a credential. */
export const AGENT_HEADER = "x-openrhen-agent";

/** The actor stamped on a write that no request made: an ingest job, travel spend, location pings, workers. */
export const SYSTEM_ACTOR = "system";

const AGENT_NAME = /^[a-z0-9_-]{1,32}$/;
const RESERVED = new Set([SYSTEM_ACTOR, "human"]);

/** What an agent's write says about itself; never logged. */
export interface WriteClaim {
  basis?: AgentBasis;
  evidence?: string;
}

/** One request's actor: an agent's name, or null for a person using the portal (no header). */
const storage = new AsyncLocalStorage<{
  actor: string | null;
  confirmedBy?: "owner";
  claim?: WriteClaim;
  scopes?: readonly string[];
  directWrites?: Readonly<Record<string, string>>;
}>();

/**
 * Reads the basis and evidence headers an agent's write may carry. A bad value is a refusal (a 400 for the
 * caller), like a bad agent name. The values are returned, never logged.
 */
export function parseClaimHeaders(headers: Headers): { ok: true; claim: WriteClaim } | { ok: false; error: string } {
  const basis = parseBasis(headers.get(BASIS_HEADER.toLowerCase()));
  if (!basis.ok) return { ok: false, error: `${BASIS_HEADER}: ${basis.reason}` };
  const evidence = parseEvidenceHeader(headers.get(EVIDENCE_HEADER.toLowerCase()));
  if (!evidence.ok) return { ok: false, error: `${EVIDENCE_HEADER}: ${evidence.reason}` };
  return {
    ok: true,
    claim: {
      ...(basis.value === undefined ? {} : { basis: basis.value }),
      ...(evidence.value === undefined ? {} : { evidence: evidence.value })
    }
  };
}

/**
 * Reads the agent header: undefined when absent, a lower-cased name when valid, or "invalid" (a bad
 * value is a 400 for the caller, never silently dropped to anonymous).
 */
export function parseAgentHeader(raw: string | null): string | undefined | "invalid" {
  if (raw === null) return undefined;
  const name = raw.trim().toLowerCase();
  if (name === "") return undefined;
  return AGENT_NAME.test(name) && !RESERVED.has(name) ? name : "invalid";
}

/**
 * Runs `fn` with this request's actor in scope; `actor` null means a person in the portal. `confirmedBy`
 * marks a write an agent proposed and the owner confirmed: the `write_rows` row names the agent as actor
 * and carries this in its evidence.
 */
export function runWithActor<T>(
  actor: string | null,
  fn: () => T,
  confirmedBy?: "owner",
  claim?: WriteClaim,
  scopes?: readonly string[],
  directWrites?: Readonly<Record<string, string>>
): T {
  const hasClaim = claim !== undefined && (claim.basis !== undefined || claim.evidence !== undefined);
  return storage.run(
    {
      actor,
      ...(confirmedBy ? { confirmedBy } : {}),
      ...(hasClaim ? { claim } : {}),
      ...(scopes ? { scopes } : {}),
      ...(directWrites ? { directWrites } : {})
    },
    fn
  );
}

/**
 * The scopes of the database token behind this request, or undefined for a person, a header-only name, an
 * environment token or a background writer. A route that treats an agent differently by scope reads this.
 */
export function requestScopes(): readonly string[] | undefined {
  const store = storage.getStore();
  return store?.actor ? store.scopes : undefined;
}

/**
 * The `directWrites` setting of the database token behind this request (entity class to mode), or undefined for a
 * person, a header-only name, an environment token or a background writer. A route outside the three save routes
 * that applies an agent's write only when direct writes are on reads this, so the Settings switch turns it off too.
 */
export function requestDirectWrites(): Readonly<Record<string, string>> | undefined {
  const store = storage.getStore();
  return store?.actor ? store.directWrites : undefined;
}

/** The basis and evidence this request's agent supplied, or undefined for a person, a background writer, or no claim. */
export function requestClaim(): WriteClaim | undefined {
  const store = storage.getStore();
  return store?.actor ? store.claim : undefined;
}

/** `owner` when this write is an agent proposal the person confirmed, else undefined. */
export function changeLogConfirmedBy(): "owner" | undefined {
  return storage.getStore()?.confirmedBy;
}

/**
 * The actor for a `write_rows` row: the request's agent name, null for a person in the portal, or
 * `system` when no request is in scope at all (a background writer).
 */
export function changeLogActor(): string | null {
  const store = storage.getStore();
  return store === undefined ? SYSTEM_ACTOR : store.actor;
}

/** The agent behind this request, or null for a person or a background writer — for `started_by`/`answered_by`. */
export function requestAgent(): string | null {
  return storage.getStore()?.actor ?? null;
}
